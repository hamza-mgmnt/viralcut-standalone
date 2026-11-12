// ffmpeg.wasm fallback decoder — LAST resort, only when the streaming
// range decode and the browser's decodeAudioData both fail (e.g. an audio
// codec Chrome cannot decode at all, such as AC-3).
//
// Facts verified from the INSTALLED packages (not guessed):
// - @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/util 0.12.2: `new FFmpeg()`,
//   load({coreURL, wasmURL}), exec(args, timeoutMs) — which prepends
//   ["-nostdin", "-y"] — writeFile/readFile/deleteFile, on("log").
//   exec's default timeout is -1 (no timeout); a 10-minute cap is passed.
// - The SINGLE-THREAD core is @ffmpeg/core ("FFmpeg WebAssembly version
//   (single thread)"); its UMD build has ZERO SharedArrayBuffer/pthread
//   references, so it works WITHOUT COOP/COEP headers. The multithread
//   core (@ffmpeg/core-mt) is the one that needs workerURL +
//   cross-origin isolation, and is deliberately NOT used.
// - Core version pinned to 0.12.9: the value of @ffmpeg/ffmpeg 0.12.15's
//   own CORE_VERSION constant (its built-in default). The core loads from
//   the jsDelivr CDN at runtime via a local download helper below (with
//   download progress); no .wasm is bundled by Next.js.
// - Do NOT use @ffmpeg/util's toBlobURL(url, mime, progress=true): its
//   downloadWithProgress fallback calls resp.arrayBuffer() AFTER its
//   reader already consumed the body, which throws "body stream already
//   disturbed" whenever the streamed byte count disagrees with
//   Content-Length (jsDelivr serves compressed bodies) — observed live
//   on 2026-11-12, breaking the whole fallback. The local helper never
//   re-reads a consumed body and never treats a Content-Length
//   mismatch as fatal.
//
// Limits: the whole file's bytes are loaded into the wasm filesystem
// (writeFile), so a very large file can still exhaust wasm memory; the
// core stays loaded for the session once downloaded (~30 MB).

import { SAMPLE_RATE } from "./audio";
import { createSilencePaddedBuffer, placeSegment, secondsToSampleIndex, wavToMono } from "./pcm";
import type { TrimPart } from "./trim";
import type { ProgressFn } from "./range-decode";

const CORE_VERSION = "0.12.9";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
const EXEC_TIMEOUT_MS = 600_000; // 10 minutes; -1 would mean "no timeout"
const INPUT_NAME = "input.mp4";
const OUTPUT_NAME = "out.wav";

type FFmpegInstance = import("@ffmpeg/ffmpeg").FFmpeg;

let ffmpegPromise: Promise<FFmpegInstance> | null = null;

/**
 * Download a URL to a blob URL, reporting (received, total) progress.
 * Exported for unit testing. Never re-reads a consumed response body:
 * when a stream reader is used, the bytes come only from the reader;
 * arrayBuffer() is used only when there is no body stream at all (the
 * body is then untouched). A Content-Length that disagrees with the
 * streamed bytes (compressed CDN responses) is reported as-is and is
 * never treated as a failure.
 */
export async function fetchToBlobURL(
  url: string,
  mimeType: string,
  onProgress?: (received: number, total: number) => void,
): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`download failed (HTTP ${resp.status}) for ${url}`);
  }
  const total = parseInt(resp.headers.get("content-length") || "-1", 10);
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  }
  const data = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    data.set(chunk, position);
    position += chunk.length;
  }
  onProgress?.(received, total);
  return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
}

/** Load the single-thread core once per session, with download progress. */
async function loadFfmpeg(onProgress?: ProgressFn): Promise<FFmpegInstance> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ffmpeg = new FFmpeg();
      const report =
        (what: string) =>
        (received: number, total: number) => {
          const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
          onProgress?.(`Downloading fallback decoder (${what})… ${pct}%`);
        };
      const coreURL = await fetchToBlobURL(
        `${CORE_BASE}/ffmpeg-core.js`,
        "text/javascript",
        report("core"),
      );
      const wasmURL = await fetchToBlobURL(
        `${CORE_BASE}/ffmpeg-core.wasm`,
        "application/wasm",
        report("decoder"),
      );
      // No workerURL: that option is only for the multithread core.
      await ffmpeg.load({ coreURL, wasmURL });
      if (!ffmpeg.loaded) throw new Error("ffmpeg core reported it did not load");
      return ffmpeg;
    })().catch((e: unknown) => {
      // Allow a later retry after a failed download.
      ffmpegPromise = null;
      throw e;
    });
  }
  return ffmpegPromise;
}

/**
 * Decode with ffmpeg.wasm. With a part, ffmpeg seeks BEFORE the input
 * (-ss <start> -t <length> -i …) so only the part is decoded; without a
 * part the whole file is decoded. Output is 16 kHz mono WAV, placed at
 * its absolute time in a full-length silence-padded buffer (same shape
 * as the other decode paths). Output may start a fraction of a second
 * off the exact seek point — irrelevant for transcription.
 */
export async function decodeWithFfmpeg(
  file: File,
  fullDurationSec: number,
  part: TrimPart | null,
  onProgress?: ProgressFn,
): Promise<Float32Array> {
  let ffmpeg: FFmpegInstance;
  try {
    ffmpeg = await loadFfmpeg(onProgress);
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown error";
    throw new Error(
      `fallback decoder could not be downloaded from the CDN (one-time ~30 MB download). Check your connection and try again. Download error: ${detail}`,
    );
  }

  const logs: string[] = [];
  const onLog = (event: { message: string }) => {
    logs.push(event.message);
    if (logs.length > 8) logs.shift();
  };
  ffmpeg.on("log", onLog);
  try {
    onProgress?.("Loading file into the fallback decoder…");
    const { fetchFile } = await import("@ffmpeg/util");
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(file));

    const args = part
      ? [
          "-ss",
          part.start.toFixed(3),
          "-t",
          Math.max(0, part.end - part.start).toFixed(3),
          "-i",
          INPUT_NAME,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-f",
          "wav",
          OUTPUT_NAME,
        ]
      : ["-i", INPUT_NAME, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", OUTPUT_NAME];
    onProgress?.("Fallback decoder is decoding the audio…");
    const code = await ffmpeg.exec(args, EXEC_TIMEOUT_MS);
    if (code !== 0) {
      const tail = logs.length ? ` Last ffmpeg output: ${logs[logs.length - 1]}` : "";
      throw new Error(`ffmpeg failed (exit code ${code}).${tail}`);
    }
    const wavData = await ffmpeg.readFile(OUTPUT_NAME);
    if (typeof wavData === "string") {
      throw new Error("fallback decoder returned text instead of audio data");
    }
    const mono = wavToMono(wavData, SAMPLE_RATE);
    if (mono.length === 0) throw new Error("fallback decoder produced no audio");
    const out =
      Number.isFinite(fullDurationSec) && fullDurationSec > 0
        ? createSilencePaddedBuffer(fullDurationSec, SAMPLE_RATE)
        : new Float32Array(mono.length);
    placeSegment(out, mono, part ? secondsToSampleIndex(part.start, SAMPLE_RATE) : 0);
    return out;
  } finally {
    ffmpeg.off("log", onLog);
    for (const name of [INPUT_NAME, OUTPUT_NAME]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // Best-effort cleanup; a stale file is overwritten next run.
      }
    }
  }
}
