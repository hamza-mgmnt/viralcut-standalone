// 12 viral caption styles. Each style has a preview (CSS) rendering and a
// canvas rendering used by export, so burned-in captions match the preview.

import type { CSSProperties } from "react";
import type { CaptionSettings, CaptionStyleId } from "./types";

export type CaptionStyle = {
  id: CaptionStyleId;
  name: string;
  /** CSS for the current word / the whole caption in the preview. */
  css: (isCurrent: boolean) => CSSProperties;
  /** Canvas paint for one word. */
  paint: (ctx: CanvasRenderingContext2D, word: string, x: number, y: number, size: number, isCurrent: boolean) => number;
};

const FONT = (size: number, weight = 800) => `${weight} ${size}px Arial, sans-serif`;

function textWidth(ctx: CanvasRenderingContext2D, word: string, size: number, weight = 800): number {
  ctx.font = FONT(size, weight);
  return ctx.measureText(word).width;
}

function paintWord(
  ctx: CanvasRenderingContext2D,
  word: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  stroke?: string,
  bg?: string,
): number {
  ctx.font = FONT(size);
  const w = ctx.measureText(word).width;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(x - size * 0.15, y - size * 1.05, w + size * 0.3, size * 1.25);
  }
  if (stroke) {
    ctx.lineWidth = Math.max(2, size * 0.12);
    ctx.strokeStyle = stroke;
    ctx.lineJoin = "round";
    ctx.strokeText(word, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(word, x, y);
  return w;
}

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  hormozi: {
    id: "hormozi",
    name: "Hormozi",
    css: (cur) => ({
      color: cur ? "#ffc233" : "#ffffff",
      textShadow: "0 2px 0 #000, 0 0 18px rgba(0,0,0,0.7)",
      textTransform: "uppercase",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, cur ? "#ffc233" : "#ffffff", "#000"),
  },
  beast: {
    id: "beast",
    name: "Beast Mode",
    css: (cur) => ({
      color: cur ? "#ffe600" : "#ffffff",
      background: cur ? "#e11d2e" : "transparent",
      padding: "0 0.15em",
      textTransform: "uppercase",
      fontWeight: 900,
      textShadow: "0 2px 0 #000",
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, cur ? "#ffe600" : "#ffffff", "#000", cur ? "#e11d2e" : undefined),
  },
  karaoke: {
    id: "karaoke",
    name: "Karaoke",
    css: (cur) => ({
      color: cur ? "#ff5c1f" : "#ffffff",
      textShadow: "0 2px 0 #000",
      fontWeight: 800,
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, cur ? "#ff5c1f" : "#ffffff", "#000"),
  },
  pop: {
    id: "pop",
    name: "Pop Pill",
    css: (cur) => ({
      color: "#111111",
      background: cur ? "#ffc233" : "#ffffff",
      borderRadius: "999px",
      padding: "0.05em 0.35em",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      const w = ctx.measureText(word).width;
      ctx.fillStyle = cur ? "#ffc233" : "#ffffff";
      const pad = size * 0.35;
      const r = size * 0.6;
      const bx = x - pad;
      const by = y - size * 1.05;
      ctx.beginPath();
      ctx.roundRect(bx, by, w + pad * 2, size * 1.25, r);
      ctx.fill();
      ctx.fillStyle = "#111111";
      ctx.fillText(word, x, y);
      return w + pad * 2;
    },
  },
  neon: {
    id: "neon",
    name: "Neon Glow",
    css: (cur) => ({
      color: cur ? "#7df9ff" : "#ffffff",
      textShadow: "0 0 8px #00e5ff, 0 0 22px #00e5ff, 0 2px 0 #000",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      ctx.shadowColor = "#00e5ff";
      ctx.shadowBlur = size * 0.5;
      const w = paintWord(ctx, word, x, y, size, cur ? "#7df9ff" : "#ffffff", "#000");
      ctx.shadowBlur = 0;
      return w;
    },
  },
  highlighter: {
    id: "highlighter",
    name: "Highlighter",
    css: (cur) => ({
      color: "#111111",
      background: cur ? "#ffe600" : "rgba(255,230,0,0.55)",
      padding: "0 0.15em",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, "#111111", undefined, cur ? "#ffe600" : "rgba(255,230,0,0.55)"),
  },
  impact: {
    id: "impact",
    name: "Bold Impact",
    css: (cur) => ({
      color: "#ffffff",
      WebkitTextStroke: "2px #000",
      textShadow: "0 3px 0 #000",
      textTransform: "uppercase",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      ctx.lineWidth = Math.max(3, size * 0.18);
      ctx.strokeStyle = "#000";
      ctx.lineJoin = "round";
      const w = ctx.measureText(word).width;
      ctx.strokeText(word, x, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(word, x, y);
      return w;
    },
  },
  fire: {
    id: "fire",
    name: "Fire",
    css: (cur) => ({
      color: cur ? "#ff7a00" : "#ffd166",
      textShadow: "0 0 12px rgba(255,90,0,0.9), 0 2px 0 #000",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      ctx.shadowColor = "#ff5a00";
      ctx.shadowBlur = size * 0.4;
      const w = paintWord(ctx, word, x, y, size, cur ? "#ff7a00" : "#ffd166", "#000");
      ctx.shadowBlur = 0;
      return w;
    },
  },
  clean: {
    id: "clean",
    name: "Clean Box",
    css: (cur) => ({
      color: "#ffffff",
      background: "rgba(0,0,0,0.65)",
      borderRadius: "6px",
      padding: "0.1em 0.35em",
      fontWeight: 800,
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, "#ffffff", undefined, "rgba(0,0,0,0.65)"),
  },
  outline: {
    id: "outline",
    name: "Outline",
    css: (cur) => ({
      color: "transparent",
      WebkitTextStroke: "2px #fff",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.strokeStyle = "#fff";
      ctx.lineJoin = "round";
      const w = ctx.measureText(word).width;
      ctx.strokeText(word, x, y);
      return w;
    },
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    css: (cur) => ({
      color: "#ffffff",
      fontWeight: 600,
      textShadow: "0 1px 6px rgba(0,0,0,0.8)",
    }),
    paint: (ctx, word, x, y, size, cur) =>
      paintWord(ctx, word, x, y, size, "#ffffff", undefined),
  },
  shadow: {
    id: "shadow",
    name: "Shadow",
    css: (cur) => ({
      color: "#ffffff",
      textShadow: "4px 4px 0 rgba(0,0,0,0.85)",
      fontWeight: 900,
    }),
    paint: (ctx, word, x, y, size, cur) => {
      ctx.font = FONT(size);
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      const w = ctx.measureText(word).width;
      ctx.fillText(word, x + size * 0.12, y + size * 0.12);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(word, x, y);
      return w;
    },
  },
};

export function captionFontSize(size: CaptionSettings["size"], outWidth: number): number {
  const base = { S: 0.055, M: 0.07, L: 0.088, XL: 0.108 }[size];
  return Math.round(outWidth * base);
}

export function captionY(position: CaptionSettings["position"], outHeight: number): number {
  if (position === "Top") return outHeight * 0.14;
  if (position === "Middle") return outHeight * 0.5;
  return outHeight * 0.82;
}

export function measureCaptionLine(
  ctx: CanvasRenderingContext2D,
  words: string[],
  size: number,
): number {
  ctx.font = FONT(size);
  let total = 0;
  for (const w of words) total += ctx.measureText(w).width + size * 0.35;
  return total;
}
