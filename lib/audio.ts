// Client-side audio: decode an MP4 to 16 kHz mono, slice into 2-minute WAV
// chunks (~3.8 MB each, safely under Groq's 25 MB per-file limit).

export const CHUNK_SECONDS = 120;
export const SAMPLE_RATE = 16000;

/** Decode a video file's audio track to 16 kHz mono Float32 samples. */
export async function decodeAudioToMono16k(file: File): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buf);
  const channel = decoded.getChannelData(0);
  const ratio = decoded.sampleRate / SAMPLE_RATE;
  const outLen = Math.floor(channel.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = channel[Math.floor(i * ratio)];
  }
  return out;
}

/** Encode mono 16 kHz Float32 samples as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Slice mono samples into 2-minute WAV blobs with their start offsets. */
export function sliceIntoChunks(samples: Float32Array): { blob: Blob; startSec: number }[] {
  const per = CHUNK_SECONDS * SAMPLE_RATE;
  const chunks: { blob: Blob; startSec: number }[] = [];
  for (let i = 0; i < samples.length; i += per) {
    const slice = samples.slice(i, Math.min(samples.length, i + per));
    chunks.push({ blob: encodeWav(slice), startSec: (i / SAMPLE_RATE) });
  }
  return chunks;
}

/** RMS energy of a mono buffer, used for clip scoring (0..1). */
export function rmsEnergy(samples: Float32Array, startSec: number, endSec: number): number {
  const a = Math.floor(startSec * SAMPLE_RATE);
  const b = Math.min(samples.length, Math.floor(endSec * SAMPLE_RATE));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / (b - a)) * 4);
}
