// Shot-aware active-speaker scan.
//
// The rule that kept breaking: NEVER average speaker positions into one
// fixed centre per shot. Inside a wide two-person shot, the camera must
// decide PER SPOKEN TURN who is speaking and frame them. Inside a close-up
// it centres that shot's own face, wherever it sits in the frame.
//
// Pipeline:
//  1. Sample the video (every 0.25s) into a small canvas.
//  2. Detect edit cuts from frame-to-frame difference spikes.
//  3. Inside each shot, for each spoken line (transcript timing), pick the
//     speaking person: face + mouth motion when the browser has
//     FaceDetector, otherwise sustained head-band motion, left vs right.
//  4. Hold rule: a turn needs >= 0.8s of consistent evidence; one-window
//     blips are rejected, so the camera never flickers.
//  5. focusAt() glides the crop: ~0.3s at a cut, ~0.8s pan inside a shot.

import type { Segment, SpeakerTurn } from "./types";

declare global {
  interface Window {
    FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
      detect(image: CanvasImageSource): Promise<{ boundingBox: DOMRectReadOnly }[]>;
    };
  }
}

export const SAMPLE_STEP = 0.25;
export const MIN_TURN_SECONDS = 0.8;

/** Crop width as a fraction of source width for a target aspect. */
export function cropWidthFraction(srcW: number, srcH: number, outW: number, outH: number): number {
  const srcAspect = srcW / srcH;
  const outAspect = outW / outH;
  return Math.min(1, outAspect / srcAspect);
}

/** Clamp a focus centre so the crop never leaves the frame. */
export function clampCropCentre(x: number, cropFrac: number): number {
  const half = cropFrac / 2;
  return Math.max(half, Math.min(1 - half, x));
}

/**
 * Convert a focus centre (0..1 of source width) to the CSS object-position
 * percentage for a video element using object-fit: cover. The centre must
 * NOT be passed straight through: object-position 75% does not put the
 * 75% point in the middle of the crop.
 */
export function objectPosPct(centre: number, cropFrac: number): number {
  if (cropFrac >= 1) return 50;
  const clamped = clampCropCentre(centre, cropFrac);
  return ((clamped - cropFrac / 2) / (1 - cropFrac)) * 100;
}

/** Pixel offset of the crop's left edge for a canvas draw, given focus centre. */
export function cropOffsetPx(centre: number, srcW: number, cropFrac: number): number {
  const cropW = srcW * cropFrac;
  const clamped = clampCropCentre(centre, cropFrac);
  return Math.max(0, Math.min(srcW - cropW, clamped * srcW - cropW / 2));
}

type Sample = {
  t: number;
  /** Downscaled luma, 32x18, for cut + motion detection. */
  luma: Float32Array;
  /** Faces found by FaceDetector: {x, y, w, h} in 0..1 of frame. */
  faces: { x: number; y: number; w: number; h: number }[];
  /** Mouth-band motion per face index, measured against the previous sample. */
  mouthMotion: number[];
};

function lumaOf(img: ImageData): Float32Array {
  const w = 32;
  const h = 18;
  const out = new Float32Array(w * h);
  const stepX = Math.floor(img.width / w);
  const stepY = Math.floor(img.height / h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (y * stepY * img.width + x * stepX) * 4;
      out[y * w + x] = 0.299 * img.data[px] + 0.587 * img.data[px + 1] + 0.114 * img.data[px + 2];
    }
  }
  return out;
}

function frameDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Scan a video element and return per-spoken-turn speaker positions.
 * Runs in the browser; faces come from FaceDetector when available,
 * otherwise from head-band motion. `onProgress` reports 0..1.
 */
export async function scanSpeakerTrack(
  video: HTMLVideoElement,
  segments: Segment[],
  onProgress?: (p: number) => void,
  range?: { start: number; end: number },
): Promise<SpeakerTurn[]> {
  const duration = video.duration || 0;
  if (!duration || segments.length === 0) return [];
  const lo = range ? Math.max(0, range.start) : 0;
  const hi = range ? Math.min(duration, range.end) : duration;
  const span = hi - lo;
  if (span <= 0) return [];
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const detector = typeof window !== "undefined" && window.FaceDetector
    ? new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 })
    : null;

  const samples: Sample[] = [];
  const n = Math.floor(span / SAMPLE_STEP);
  for (let i = 0; i <= n; i++) {
    const t = Math.min(hi - 0.05, lo + i * SAMPLE_STEP);
    video.currentTime = t;
    await new Promise<void>((resolve) => {
      const onSeek = () => {
        video.removeEventListener("seeked", onSeek);
        resolve();
      };
      video.addEventListener("seeked", onSeek);
      setTimeout(resolve, 400); // never hang the scan on one frame
    });
    ctx.drawImage(video, 0, 0, 64, 36);
    const img = ctx.getImageData(0, 0, 64, 36);
    const luma = lumaOf(img);
    let faces: Sample["faces"] = [];
    let mouthMotion: number[] = [];
    if (detector) {
      try {
        const found = await detector.detect(video);
        faces = found
          .map((f) => ({
            x: f.boundingBox.x / video.videoWidth,
            y: f.boundingBox.y / video.videoHeight,
            w: f.boundingBox.width / video.videoWidth,
            h: f.boundingBox.height / video.videoHeight,
          }))
          .filter((f) => f.w > 0.02 && f.w < 0.6);
      } catch {
        faces = [];
      }
    }
    if (samples.length > 0) {
      const prev = samples[samples.length - 1];
      // Motion in the lower half of each face box = mouth/jaw movement.
      mouthMotion = faces.map((f) => {
        let sum = 0;
        let count = 0;
        const x0 = Math.floor(f.x * 32);
        const x1 = Math.min(32, Math.floor((f.x + f.w) * 32));
        const y0 = Math.floor((f.y + f.h * 0.55) * 18);
        const y1 = Math.min(18, Math.floor((f.y + f.h) * 18));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = y * 32 + x;
            sum += Math.abs(luma[idx] - prev.luma[idx]);
            count++;
          }
        }
        return count ? sum / count : 0;
      });
    }
    samples.push({ t, luma, faces, mouthMotion });
    if (onProgress) onProgress(i / Math.max(1, n));
  }

  return buildTurnsFromSamples(samples, segments, video.videoWidth / video.videoHeight);
}

/** Detect cut times from frame differences (pure, unit-testable). */
export function detectCuts(samples: { t: number; luma: Float32Array }[]): number[] {
  const cuts: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    const d = frameDiff(samples[i].luma, samples[i - 1].luma);
    // A cut is a sharp spike well above normal motion; threshold tuned for
    // 144p interview footage where faces are ~30px wide.
    if (d > 14) cuts.push(samples[i].t);
  }
  return cuts;
}

/** Median of numbers, robust against stray detections. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0.5;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Build per-spoken-turn speaker positions from scan samples.
 * Pure function over samples so it can be unit tested.
 */
export function buildTurnsFromSamples(
  samples: Sample[],
  segments: Segment[],
  _aspect: number,
): SpeakerTurn[] {
  if (samples.length === 0 || segments.length === 0) return [];
  const cuts = detectCuts(samples);
  const shotOf = (t: number): number => {
    let shot = 0;
    for (let i = 0; i < cuts.length; i++) if (t >= cuts[i]) shot = i;
    return shot;
  };

  const turns: SpeakerTurn[] = [];
  for (const seg of segments) {
    const mid = (seg.start + seg.end) / 2;
    const shot = shotOf(mid);
    const shotStart = cuts[shot];
    const shotEnd = shot + 1 < cuts.length ? cuts[shot + 1] : samples[samples.length - 1].t + SAMPLE_STEP;
    const inShot = samples.filter((s) => s.t >= Math.max(shotStart, seg.start) && s.t <= Math.min(shotEnd, seg.end));
    if (inShot.length === 0) continue;

    // Faces seen in this shot, clustered by horizontal centre.
    const faceCentres: number[] = [];
    const faceMotion: { x: number; motion: number }[] = [];
    for (const s of inShot) {
      s.faces.forEach((f, fi) => {
        faceCentres.push(f.x + f.w / 2);
        faceMotion.push({ x: f.x + f.w / 2, motion: s.mouthMotion[fi] ?? 0 });
      });
    }
    // Cluster centres that are close together (same person, jittery box).
    const clusters: number[][] = [];
    for (const c of [...faceCentres].sort((a, b) => a - b)) {
      const last = clusters[clusters.length - 1];
      if (last && c - median(last) < 0.12) last.push(c);
      else clusters.push([c]);
    }
    const clusterCentres = clusters.map((c) => median(c)).filter((c) => c > 0.05 && c < 0.95);

    let x: number;
    let side: "left" | "right";
    if (clusterCentres.length === 1) {
      // One person in frame: centre them, wherever they sit.
      x = clusterCentres[0];
    } else if (clusterCentres.length >= 2) {
      // Two people: who is speaking during this line? Use mouth motion.
      const motionByCluster = clusterCentres.map((cc) => {
        const near = faceMotion.filter((fm) => Math.abs(fm.x - cc) < 0.12);
        return near.length ? near.reduce((a, b) => a + b.motion, 0) / near.length : 0;
      });
      const best = motionByCluster.indexOf(Math.max(...motionByCluster));
      if (Math.max(...motionByCluster) > 0.5) {
        x = clusterCentres[best];
      } else {
        // No clear mouth signal: fall back to head-band motion per side.
        x = motionSide(inShot, clusterCentres);
      }
    } else {
      // No faces detected (e.g. 144p, no FaceDetector): head-band motion.
      x = motionSide(inShot, []);
    }
    side = x < 0.5 ? "left" : "right";

    // Hold rule: merge with the previous turn when the evidence is a blip
    // (same speaker, very short line) or the position barely moved.
    const prev = turns[turns.length - 1];
    if (prev && seg.end - seg.start < MIN_TURN_SECONDS && Math.abs(x - prev.x) < 0.15) {
      prev.end = seg.end;
      continue;
    }
    if (prev && Math.abs(x - prev.x) < 0.06 && shotOf(prev.start) === shot) {
      prev.end = seg.end;
      continue;
    }
    turns.push({
      start: seg.start,
      end: seg.end,
      x,
      side,
      cut: shotOf(seg.start) !== (prev ? shotOf(prev.start) : -1),
    });
  }
  // Merge adjacent turns on the same speaker within the same shot.
  const merged: SpeakerTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(t.x - last.x) < 0.08 && !t.cut) last.end = t.end;
    else merged.push({ ...t });
  }
  return merged;
}

/** Head-band motion fallback: which side of the frame moved more. */
function motionSide(samples: Sample[], clusterCentres: number[]): number {
  if (samples.length < 2) return 0.5;
  let left = 0;
  let right = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i].luma;
    const b = samples[i - 1].luma;
    for (let y = 4; y < 14; y++) {
      for (let x = 0; x < 32; x++) {
        const d = Math.abs(a[y * 32 + x] - b[y * 32 + x]);
        if (x < 16) left += d;
        else right += d;
      }
    }
  }
  if (clusterCentres.length >= 2) {
    return left >= right ? Math.min(...clusterCentres) : Math.max(...clusterCentres);
  }
  if (left + right < 1) return 0.5; // no motion at all: stay centred
  // Single subject fallback: motion centroid across the head band.
  let sumX = 0;
  let sumW = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i].luma;
    const b = samples[i - 1].luma;
    for (let y = 4; y < 14; y++) {
      for (let x = 0; x < 32; x++) {
        const d = Math.abs(a[y * 32 + x] - b[y * 32 + x]);
        sumX += (x / 32) * d;
        sumW += d;
      }
    }
  }
  return sumW ? Math.max(0.15, Math.min(0.85, sumX / sumW)) : 0.5;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Focus centre at time t, gliding smoothly: ~0.3s after an edit cut,
 * ~0.8s pan when the speaker changes inside a shot.
 */
export function focusAt(turns: SpeakerTurn[], t: number, fallback = 0.5): number {
  if (turns.length === 0) return fallback;
  let idx = 0;
  for (let i = 0; i < turns.length; i++) if (t >= turns[i].start) idx = i;
  const cur = turns[idx];
  if (t < cur.start) return turns[0].x;
  if (idx === 0) return cur.x;
  const prev = turns[idx - 1];
  const since = t - cur.start;
  const glide = cur.cut ? 0.3 : 0.8;
  if (since >= glide) return cur.x;
  return prev.x + (cur.x - prev.x) * smoothstep(since / glide);
}

/** Apply a brain turn list: brain decides per spoken turn; missing turns fall back to the scan. */
export function mergeBrainTurns(brain: SpeakerTurn[], scan: SpeakerTurn[]): SpeakerTurn[] {
  if (brain.length === 0) return scan;
  const out: SpeakerTurn[] = [];
  for (const s of scan) {
    const b = brain.find((t) => s.start < t.end - 0.2 && s.end > t.start + 0.2);
    out.push(b ? { ...s, x: b.x, side: b.side } : s);
  }
  return out;
}
