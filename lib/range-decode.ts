// Streaming range decode: decode ONLY the trimmed part of an MP4's audio
// track with mp4box.js + WebCodecs, without loading or decoding the whole
// file. This is the primary decode path when Trim is ON.
//
// Flow (verified empirically against mp4box 2.5.0 with the project's
// 50-minute test file, whose moov box sits at the END of the file):
//   1. Feed 1 MB slices from the start. appendBuffer() returns the offset
//      it wants next — for a moov-at-end file it jumps straight to moov,
//      so the 62 MB mdat is skipped, not read.
//   2. onReady fires once moov is parsed. Pick the first audio track.
//   3. seek(part.start) returns {offset, time}; feed 1 MB slices from that
//      offset, honouring forward redirects from appendBuffer().
//   4. onSamples delivers audio samples in file order (dts monotonic,
//      dts == cts on the test files). Samples are wrapped in
//      EncodedAudioChunk (microsecond timestamps from dts/timescale) and
//      fed to an AudioDecoder; decoded AudioData is copied to planar
//      float32, downmixed, resampled to 16 kHz and placed at its ABSOLUTE
//      time in a full-length silence-padded buffer.
//   5. Stop feeding once sample times pass part.end (+ margin), then
//      flush. On the 50-minute test file a 10-minute part reads ~26% of
//      the file. Memory stays bounded: mp4box is created WITHOUT
//      keepMdatData (media bytes are discarded after parsing) and used
//      samples are released per batch.
//
// Output: a FULL-LENGTH 16 kHz mono Float32Array (silence outside the
// part, real samples inside), so sliceRangeIntoChunks, rmsEnergy and the
// transcript stitching all keep using absolute video time unchanged.

import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Sample, type Track } from "mp4box";
import { SAMPLE_RATE } from "./audio";
import {
  buildAacAudioSpecificConfig,
  createSilencePaddedBuffer,
  downmixToMono,
  extractEsdsDecoderSpecificInfo,
  placeSegment,
  resampleNearest,
  secondsToSampleIndex,
} from "./pcm";
import type { TrimPart } from "./trim";

type Mp4File = ISOFile<unknown, unknown>;

const READ_CHUNK_BYTES = 1024 * 1024;
const SAMPLES_PER_BATCH = 500;
/** Keep feeding a little past the part end so the last second decodes cleanly. */
const STOP_MARGIN_SEC = 2;
/** Samples this far past the part end are not worth decoding. */
const DECODE_MARGIN_SEC = 1;
/** Guard against redirect loops from appendBuffer(). */
const MAX_REDIRECTS = 16;

export type ProgressFn = (text: string) => void;

async function readSlice(file: File, offset: number, length: number): Promise<MP4BoxBuffer> {
  const ab = await file.slice(offset, offset + length).arrayBuffer();
  return MP4BoxBuffer.fromArrayBuffer(ab, offset);
}

/**
 * Feed the file from offset 0 until mp4box fires onReady (moov parsed),
 * honouring forward jumps returned by appendBuffer(). Backward jumps are
 * ignored — mp4box can ask for an earlier offset while it is still
 * parsing moov, and continuing sequentially is what works.
 */
async function feedUntilReady(
  mp4: Mp4File,
  file: File,
  isReady: () => boolean,
  onProgress?: ProgressFn,
): Promise<void> {
  let off = 0;
  let redirects = 0;
  const seen = new Set<number>();
  while (off < file.size && !isReady()) {
    const len = Math.min(READ_CHUNK_BYTES, file.size - off);
    const buf = await readSlice(file, off, len);
    const next = mp4.appendBuffer(buf);
    off += len;
    if (typeof next === "number" && next > off && !seen.has(next) && redirects < MAX_REDIRECTS) {
      seen.add(next);
      off = next;
      redirects++;
    }
    onProgress?.("Reading video header…");
  }
}

/** Best-effort extraction of the esds DecoderSpecificInfo bytes, if any. */
function esdsDescription(mp4: Mp4File): Uint8Array | null {
  try {
    const boxes = mp4.getBoxes("esds", false);
    for (const box of boxes) {
      const found = extractEsdsDecoderSpecificInfo((box as { esd?: unknown }).esd);
      if (found) return found;
    }
  } catch {
    // esds is a bonus candidate; the synthesized config is primary.
  }
  return null;
}

/**
 * Build the AudioDecoder config from the OBSERVED track structure
 * (codec string, sample_rate, channel_count, esds bytes). For AAC,
 * candidate descriptions are tried in order — synthesized
 * AudioSpecificConfig first, then the esds bytes — and each is checked
 * with AudioDecoder.isConfigSupported when the browser provides it.
 * Non-AAC codecs are attempted without a description; when the browser
 * reports the config unsupported, this throws and the caller falls back
 * to the full decode / ffmpeg paths.
 */
async function pickDecoderConfig(mp4: Mp4File, track: Track): Promise<AudioDecoderConfig> {
  const audio = track.audio;
  if (!audio) throw new Error("audio track has no audio information");
  const codec = track.codec;
  const base = { codec, sampleRate: audio.sample_rate, numberOfChannels: audio.channel_count };

  const candidates: Array<Uint8Array | undefined> = [];
  const pushUnique = (bytes: Uint8Array | undefined | null) => {
    if (!bytes) {
      if (!candidates.includes(undefined)) candidates.push(undefined);
      return;
    }
    const key = [...bytes].join(",");
    const exists = candidates.some((c) => c && [...c].join(",") === key);
    if (!exists) candidates.push(bytes);
  };

  const aac = /^mp4a\.40\.(\d+)$/.exec(codec);
  if (aac) {
    const objectType = parseInt(aac[1], 10);
    pushUnique(buildAacAudioSpecificConfig(objectType, audio.sample_rate, audio.channel_count));
    const esds = esdsDescription(mp4);
    if (esds) {
      pushUnique(esds);
      if (esds.length > 2) pushUnique(esds.slice(0, 2));
    }
  }
  pushUnique(undefined);

  const canCheck =
    typeof AudioDecoder !== "undefined" && typeof AudioDecoder.isConfigSupported === "function";
  for (const description of candidates) {
    const config: AudioDecoderConfig = description
      ? { ...base, description: description.slice().buffer as ArrayBuffer }
      : { ...base };
    if (!canCheck) return config;
    try {
      const verdict = await AudioDecoder.isConfigSupported(config);
      if (verdict.supported) return config;
    } catch {
      // A throwing support check must not hide a config that works.
      return config;
    }
  }
  throw new Error(
    `streaming decode cannot handle this audio codec (${codec}) — the browser reports no supported decoder config`,
  );
}

/**
 * Decode only [part.start, part.end) of the file's audio into a
 * full-length silence-padded 16 kHz mono buffer.
 */
export async function decodeTrimmedRange(
  file: File,
  fullDurationSec: number,
  part: TrimPart,
  onProgress?: ProgressFn,
): Promise<Float32Array> {
  if (typeof AudioDecoder === "undefined" || typeof EncodedAudioChunk === "undefined") {
    throw new Error("streaming decode is not available in this browser (no WebCodecs AudioDecoder)");
  }
  if (!Number.isFinite(fullDurationSec) || fullDurationSec <= 0) {
    throw new Error("streaming decode needs the video duration, which is not known yet");
  }
  const out = createSilencePaddedBuffer(fullDurationSec, SAMPLE_RATE);
  const mp4 = createFile();
  let decoder: AudioDecoder | null = null;
  let decodeError: Error | null = null;
  let parseError: Error | null = null;
  let outputs = 0;
  let lastSampleEndSec = 0;
  let lastSampleNumber = -1;

  try {
    let info: Movie | null = null;
    mp4.onReady = (movie) => {
      info = movie;
    };
    mp4.onError = (_module, message) => {
      if (!parseError) parseError = new Error(`MP4 parse error: ${message}`);
    };
    await feedUntilReady(mp4, file, () => info != null, onProgress);
    if (!info) {
      throw parseError ?? new Error("could not read the MP4 header (moov box not found)");
    }
    const movie: Movie = info;
    if (movie.isFragmented) {
      throw new Error("fragmented MP4 files are not supported by streaming decode");
    }
    const track = movie.audioTracks[0] ?? movie.tracks.find((t) => t.type === "audio");
    if (!track) throw new Error("no audio track found in this file");

    const config = await pickDecoderConfig(mp4, track);
    decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          // Output timestamps track the input chunk timestamps; AAC
          // priming can shift them by a few tens of ms, which does not
          // matter for transcription.
          const timeSec = audioData.timestamp / 1e6;
          const planes: Float32Array[] = [];
          for (let c = 0; c < audioData.numberOfChannels; c++) {
            const plane = new Float32Array(audioData.numberOfFrames);
            audioData.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            planes.push(plane);
          }
          const mono = downmixToMono(planes);
          const resampled = resampleNearest(mono, audioData.sampleRate, SAMPLE_RATE);
          placeSegment(out, resampled, secondsToSampleIndex(timeSec, SAMPLE_RATE));
          outputs++;
        } finally {
          audioData.close();
        }
      },
      error: (e) => {
        if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
      },
    });
    decoder.configure(config);

    const activeDecoder = decoder;
    mp4.onSamples = (_id: number, _user: unknown, samples: Sample[]) => {
      for (const s of samples) {
        const endSec = (s.dts + s.duration) / s.timescale;
        if (endSec > lastSampleEndSec) lastSampleEndSec = endSec;
        lastSampleNumber = s.number;
        const dtsSec = s.dts / s.timescale;
        if (s.data && dtsSec < part.end + DECODE_MARGIN_SEC) {
          // dts is the decode timestamp (decode order); on the test
          // files dts == cts. Copy the data: mp4box reuses its buffers.
          const chunk = new EncodedAudioChunk({
            type: "key",
            timestamp: Math.round((s.dts * 1e6) / s.timescale),
            duration: Math.round((s.duration * 1e6) / s.timescale),
            data: s.data.slice(),
          });
          activeDecoder.decode(chunk);
        }
      }
      try {
        if (lastSampleNumber >= 0) mp4.releaseUsedSamples(track.id, lastSampleNumber + 1);
      } catch {
        // Releasing is a memory optimisation, not correctness.
      }
    };
    mp4.setExtractionOptions(track.id, null, { nbSamples: SAMPLES_PER_BATCH });
    mp4.start();
    const seeked = mp4.seek(part.start, false);

    // Feed mdat from the seek offset until past the part end.
    let off = seeked.offset;
    let redirects = 0;
    const seen = new Set<number>();
    const pastEnd = () => lastSampleNumber >= 0 && lastSampleEndSec > part.end + STOP_MARGIN_SEC;
    while (off < file.size && !pastEnd()) {
      const len = Math.min(READ_CHUNK_BYTES, file.size - off);
      const buf = await readSlice(file, off, len);
      const next = mp4.appendBuffer(buf);
      off += len;
      if (typeof next === "number" && next > off && !seen.has(next) && redirects < MAX_REDIRECTS) {
        seen.add(next);
        off = next;
        redirects++;
      }
      // Bound the decoder queue: drain if the decoder falls behind.
      if (activeDecoder.decodeQueueSize > 500) await activeDecoder.flush();
      const span = Math.max(part.end - part.start, 1);
      const donePct = Math.min(
        100,
        Math.max(0, Math.round(((lastSampleEndSec - part.start) / span) * 100)),
      );
      onProgress?.(`Decoding trimmed part… ${donePct}%`);
    }
    mp4.flush();
    await activeDecoder.flush();
    if (decodeError) throw decodeError;
    if (outputs === 0) {
      throw new Error("no audio samples were decoded from the trimmed part");
    }
    return out;
  } finally {
    try {
      mp4.stop();
    } catch {
      // ignore cleanup errors
    }
    if (decoder) {
      try {
        decoder.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
