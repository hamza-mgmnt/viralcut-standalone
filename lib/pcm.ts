// Pure PCM helpers shared by the streaming range decoder and the ffmpeg
// fallback. No browser or library APIs here, so every function is unit
// testable with bun. All time placement uses ABSOLUTE video time: decoded
// audio lands in a full-length silence-padded buffer at its original
// position, so downstream code (chunk slicing, RMS energy, transcripts)
// keeps working unchanged.

/** AAC sampling-frequency table (index -> Hz), ISO/IEC 14496-3. */
export const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Sampling-frequency index for an AAC AudioSpecificConfig, or null. */
export function aacSamplingFrequencyIndex(sampleRate: number): number | null {
  const idx = AAC_SAMPLE_RATES.indexOf(sampleRate);
  return idx === -1 ? null : idx;
}

/**
 * Build the 2-byte AAC AudioSpecificConfig from the observed track facts:
 * audio object type (from the codec string, e.g. mp4a.40.2 -> 2 = AAC LC),
 * sample rate and channel count.
 * Verified against a real file: objectType 2, 44100 Hz, 2 channels ->
 * bytes 0x12 0x10, identical to the first two bytes of that file's esds
 * DecoderSpecificInfo. Returns null when the sample rate has no table
 * index (callers then fall back to the esds bytes, if any).
 */
export function buildAacAudioSpecificConfig(
  objectType: number,
  sampleRate: number,
  channelCount: number,
): Uint8Array | null {
  const freqIndex = aacSamplingFrequencyIndex(sampleRate);
  if (freqIndex == null) return null;
  if (objectType < 1 || objectType > 31 || channelCount < 1 || channelCount > 7) return null;
  const b0 = (objectType << 3) | (freqIndex >> 1);
  const b1 = ((freqIndex & 1) << 7) | (channelCount << 3);
  return new Uint8Array([b0, b1]);
}

/**
 * Extract the DecoderSpecificInfo bytes (MPEG-4 descriptor tag 5) from an
 * esds ElementaryStreamDescriptor tree. mp4box parses esds into nested
 * descriptor objects with `tag`, `descs` and `data` fields; this walks
 * that tree defensively because the structure varies between encoders.
 * Returns a copy of the raw bytes, or null when no tag-5 descriptor exists.
 * Observed on a real file: 16 bytes, `12 10` followed by fourteen zero
 * bytes — callers treat the first two bytes as the AudioSpecificConfig
 * and only use the full blob as a last-resort decoder config candidate.
 */
export function extractEsdsDecoderSpecificInfo(esd: unknown): Uint8Array | null {
  const visit = (node: unknown): Uint8Array | null => {
    if (typeof node !== "object" || node === null) return null;
    const rec = node as { tag?: unknown; data?: unknown; descs?: unknown };
    if (rec.tag === 5 && rec.data instanceof Uint8Array && rec.data.length > 0) {
      return rec.data.slice();
    }
    if (Array.isArray(rec.descs)) {
      for (const child of rec.descs) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(esd);
}

/** Average channel planes into mono. A single plane is copied unchanged. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Nearest-neighbour resample (same algorithm as the existing
 * decodeAudioData path in lib/audio.ts, so both decoders sound alike).
 * Equal rates return a copy.
 */
export function resampleNearest(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0 || fromRate <= 0 || toRate <= 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

/** Sample index for an absolute time, rounding to the nearest sample. */
export function secondsToSampleIndex(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

/** Full-length buffer of silence; decoded ranges are placed into it. */
export function createSilencePaddedBuffer(durationSec: number, sampleRate: number): Float32Array {
  return new Float32Array(Math.max(0, Math.ceil(durationSec * sampleRate)));
}

/**
 * Copy a decoded segment into the padded buffer at an absolute index.
 * Parts falling outside the buffer are clipped, never wrapped or thrown.
 * Later writes overwrite earlier ones (decoded samples arrive in order).
 */
export function placeSegment(out: Float32Array, segment: Float32Array, startIndex: number): void {
  if (segment.length === 0) return;
  const start = Math.max(0, startIndex);
  const end = Math.min(out.length, startIndex + segment.length);
  if (end <= start) return;
  const offset = start - startIndex;
  out.set(segment.subarray(offset, offset + (end - start)), start);
}

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  /** Interleaved float samples in [-1, 1]. */
  samples: Float32Array;
}

/**
 * Parse a RIFF/WAVE file's PCM data. Supports 16-bit integer PCM (what
 * ffmpeg -f wav writes) and 32-bit float PCM. Extra chunks (LIST, fact,
 * …) and odd-size chunk padding are skipped by scanning subchunk headers.
 * Throws a descriptive error on malformed input.
 */
export function parseWavPcm(bytes: Uint8Array): ParsedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off: number, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (bytes.byteLength < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file (bad header)");
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt " && size >= 16) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, bytes.byteLength - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new Error("WAV file has no fmt chunk");
  if (dataOff < 0) throw new Error("WAV file has no data chunk");
  if (fmt.channels < 1 || fmt.sampleRate <= 0) throw new Error("WAV file has invalid fmt values");
  const samples = new Float32Array(Math.floor(dataLen / (fmt.bits / 8)));
  if (fmt.format === 1 && fmt.bits === 16) {
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(dataOff + i * 2, true) / 32768;
  } else if (fmt.format === 3 && fmt.bits === 32) {
    for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(dataOff + i * 4, true);
  } else {
    throw new Error(`unsupported WAV format (format=${fmt.format}, ${fmt.bits}-bit)`);
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** WAV bytes -> mono samples at targetRate (deinterleave + downmix + resample). */
export function wavToMono(wavBytes: Uint8Array, targetRate: number): Float32Array {
  const wav = parseWavPcm(wavBytes);
  const frames = Math.floor(wav.samples.length / wav.channels);
  const planes: Float32Array[] = [];
  for (let c = 0; c < wav.channels; c++) {
    const plane = new Float32Array(frames);
    for (let i = 0; i < frames; i++) plane[i] = wav.samples[i * wav.channels + c];
    planes.push(plane);
  }
  return resampleNearest(downmixToMono(planes), wav.sampleRate, targetRate);
}
