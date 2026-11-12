// Decode orchestration: tries the decoders in order and reports which
// one produced the audio. The heavy decoders are dynamically imported so
// mp4box and ffmpeg.wasm stay out of the initial page bundle.
//
// Decision flowchart (as implemented):
//   Trim ON (part given, duration known):
//     1. streaming range decode (mp4box + WebCodecs, part only)
//     2. full decode (decodeAudioData, whole file)
//     3. ffmpeg.wasm fallback (seek to the part)
//   Trim OFF (no part):
//     1. full decode (decodeAudioData, whole file)
//     2. ffmpeg.wasm fallback (whole file)
//   All failed -> ONE error naming everything tried + the file size.

import { decodeAudioToMono16k } from "./audio";
import type { TrimPart } from "./trim";
import type { ProgressFn } from "./range-decode";

export type DecodeMethod = "streaming" | "full" | "fallback";

export const DECODE_METHOD_LABELS: Record<DecodeMethod, string> = {
  streaming: "Audio: trimmed range only (streaming)",
  full: "Audio: full decode",
  fallback: "Audio: fallback decoder",
};

function shortError(e: unknown, maxLen = 200): string {
  const msg = e instanceof Error ? e.message : String(e);
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

export async function decodeAudio(
  file: File,
  fullDurationSec: number,
  part: TrimPart | null,
  onProgress?: ProgressFn,
): Promise<{ samples: Float32Array; method: DecodeMethod }> {
  const attempts: string[] = [];
  const useRange = part != null && Number.isFinite(fullDurationSec) && fullDurationSec > 0;

  if (useRange && part) {
    onProgress?.("Decoding only the trimmed part (streaming)…");
    try {
      const { decodeTrimmedRange } = await import("./range-decode");
      const samples = await decodeTrimmedRange(file, fullDurationSec, part, onProgress);
      return { samples, method: "streaming" };
    } catch (e) {
      attempts.push(`streaming range decode (${shortError(e)})`);
    }
  }

  onProgress?.(
    attempts.length > 0 ? "Streaming decode failed — decoding the full file…" : "Reading audio…",
  );
  try {
    const samples = await decodeAudioToMono16k(file);
    return { samples, method: "full" };
  } catch (e) {
    attempts.push(`full decode (${shortError(e)})`);
  }

  onProgress?.("Loading the fallback decoder (one-time ~30 MB download)…");
  try {
    const { decodeWithFfmpeg } = await import("./ffmpeg-decode");
    const samples = await decodeWithFfmpeg(file, fullDurationSec, part, onProgress);
    return { samples, method: "fallback" };
  } catch (e) {
    attempts.push(`fallback decoder (${shortError(e)})`);
  }

  throw new Error(
    `Unable to decode this video's audio (${(file.size / 1e6).toFixed(1)} MB). ` +
      `Tried: ${attempts.join("; ")}. ` +
      "The file may use an audio codec no decoder here supports — try re-exporting it as MP4 with AAC audio.",
  );
}
