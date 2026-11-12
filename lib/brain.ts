// Client side of the Gemini AI Brain: sample video frames and ask the
// server route to analyse them. The API key never reaches the client.

import type { BrainResult, BrainStatus, Segment } from "./types";

export async function sampleFrames(
  video: HTMLVideoElement,
  everySec = 2,
  maxFrames = 48,
  range?: { start: number; end: number },
): Promise<{ t: number; jpeg: string }[]> {
  const duration = video.duration || 0;
  const lo = range ? Math.max(0, range.start) : 0;
  const hi = range ? Math.min(duration, range.end) : duration;
  const span = Math.max(0, hi - lo);
  if (!span) return [];
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = Math.round((320 * video.videoHeight) / Math.max(1, video.videoWidth));
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const frames: { t: number; jpeg: string }[] = [];
  const count = Math.min(maxFrames, Math.max(1, Math.floor(span / everySec)));
  for (let i = 0; i < count; i++) {
    const t = Math.min(hi - 0.1, lo + (i * span) / count);
    video.currentTime = t;
    await new Promise<void>((resolve) => {
      const onSeek = () => {
        video.removeEventListener("seeked", onSeek);
        resolve();
      };
      video.addEventListener("seeked", onSeek);
      setTimeout(resolve, 400);
    });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({ t, jpeg: canvas.toDataURL("image/jpeg", 0.6) });
  }
  return frames;
}

export async function runBrain(
  frames: { t: number; jpeg: string }[],
  segments: Segment[],
  durationSec: number,
  onStatus?: (s: BrainStatus, model?: string, error?: string) => void,
): Promise<BrainResult | null> {
  onStatus?.("working");
  try {
    const res = await fetch("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames, segments, durationSec }),
    });
    const data = await res.json();
    if (!res.ok) {
      onStatus?.("unavailable", undefined, data?.error || `Brain failed (${res.status})`);
      return null;
    }
    onStatus?.("online", data.modelUsed);
    return data as BrainResult;
  } catch (e) {
    onStatus?.("unavailable", undefined, e instanceof Error ? e.message : "Brain request failed");
    return null;
  }
}
