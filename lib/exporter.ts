// Export a clip via canvas + MediaRecorder (WebM). The same focus track
// and caption styles are used as in the preview.

import { captionFontSize, captionY, CAPTION_STYLES, measureCaptionLine } from "./captions";
import { cropOffsetPx, cropWidthFraction, focusAt } from "./speaker";
import type { CaptionSettings, Clip, SpeakerTurn } from "./types";
import { wordTimings } from "./clips";

export type Aspect = "9:16" | "1:1" | "16:9";

export function aspectSize(aspect: Aspect): { w: number; h: number } {
  if (aspect === "1:1") return { w: 720, h: 720 };
  if (aspect === "16:9") return { w: 1280, h: 720 };
  return { w: 720, h: 1280 };
}

export async function exportClip(
  video: HTMLVideoElement,
  clip: Clip,
  turns: SpeakerTurn[],
  captions: CaptionSettings,
  aspect: Aspect,
  highlightWords: string[],
  onProgress?: (p: number) => void,
): Promise<Blob> {
  const { w: outW, h: outH } = aspectSize(aspect);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    recorder.onerror = () => reject(new Error("Export failed"));
  });

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const cropFrac = cropWidthFraction(srcW, srcH, outW, outH);
  const cropW = srcW * cropFrac;
  const cropH = srcH;
  const style = CAPTION_STYLES[captions.style];
  const fontSize = captionFontSize(captions.size, outW);
  const capY = captionY(captions.position, outH);
  const words = clip.segments.flatMap((s) => wordTimings(s));

  video.currentTime = clip.start;
  await new Promise<void>((r) => {
    const h = () => {
      video.removeEventListener("seeked", h);
      r();
    };
    video.addEventListener("seeked", h);
    setTimeout(r, 500);
  });
  await video.play();
  recorder.start(200);

  const total = clip.end - clip.start;
  await new Promise<void>((resolve) => {
    const draw = () => {
      const t = video.currentTime;
      if (t >= clip.end || video.ended) {
        resolve();
        return;
      }
      const rel = t - clip.start;
      const focus = focusAt(turns, t, 0.5);
      const offX = cropOffsetPx(focus, srcW, cropFrac);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(video, offX, 0, cropW, cropH, 0, 0, outW, outH);
      if (captions.enabled) {
        const active = words.filter((w) => t >= w.start && t < w.end + 0.35);
        const line = words.filter((w) => Math.abs(w.start - t) < 1.2).slice(0, 8);
        const show = active.length ? active : line.slice(0, 4);
        if (show.length) {
          const lineWidth = measureCaptionLine(ctx, show.map((w) => w.word), fontSize);
          let x = (outW - lineWidth) / 2;
          ctx.textBaseline = "alphabetic";
          for (const w of show) {
            const isCur = t >= w.start && t < w.end + 0.15;
            const isHi = highlightWords.some((hw) => hw.toLowerCase() === w.word.toLowerCase().replace(/[^a-z']/g, ""));
            const wpx = style.paint(ctx, w.word, x, capY, fontSize, isCur || isHi);
            x += wpx + fontSize * 0.35;
          }
        }
      }
      if (onProgress) onProgress(Math.min(1, rel / total));
      requestAnimationFrame(draw);
    };
    draw();
  });
  video.pause();
  recorder.stop();
  return done;
}
