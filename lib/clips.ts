// Clip building from the real transcript. Never invents hooks: every title,
// description and score reason is grounded in a transcript line.

import type { Clip, Scores, Segment } from "./types";

const EMOTION_WORDS = [
  "love", "hate", "amazing", "terrible", "shocking", "crazy", "incredible",
  "secret", "mistake", "fail", "win", "best", "worst", "never", "always",
  "free", "money", "problem", "pressure", "fear", "dream", "truth",
];
const QUESTION_WORDS = ["how", "why", "what", "when", "which", "who"];

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, "").split(/\s+/).filter(Boolean);
}

function lineScore(text: string): { score: number; cues: string[] } {
  const ws = words(text);
  const cues: string[] = [];
  let score = 0;
  if (ws.length >= 4 && ws.length <= 22) score += 12;
  if (QUESTION_WORDS.includes(ws[0])) {
    score += 18;
    cues.push("opens with a question");
  }
  for (const w of ws) {
    if (EMOTION_WORDS.includes(w)) {
      score += 8;
      cues.push(`strong word "${w}"`);
      break;
    }
  }
  if (/\d/.test(text)) {
    score += 8;
    cues.push("has a concrete number");
  }
  if (/[!?]/.test(text)) {
    score += 6;
    cues.push("emphatic delivery");
  }
  return { score, cues: cues.slice(0, 2) };
}

function grade(score: number): "A" | "B" | "C" {
  if (score >= 75) return "A";
  if (score >= 55) return "B";
  return "C";
}

function makeScores(
  hookText: string,
  bodyText: string,
  durationSec: number,
  energy: number,
): Scores {
  const hookLine = lineScore(hookText);
  const hookScore = Math.min(96, 45 + hookLine.score + Math.round(energy * 10));
  const flowScore = Math.min(96, durationSec >= 30 && durationSec <= 60 ? 82 : 64);
  const valueScore = Math.min(96, 50 + Math.min(30, Math.floor(bodyText.length / 40)));
  const trendScore = Math.min(90, 48 + (hookLine.cues.length ? 14 : 0) + Math.round(energy * 12));
  const total = Math.round(
    (hookScore * 0.3 + flowScore * 0.25 + valueScore * 0.25 + trendScore * 0.2) / 1,
  );
  return {
    hook: {
      grade: grade(hookScore),
      score: hookScore,
      reason: hookLine.cues.length
        ? `Hook line ${hookLine.cues.join(" and ")}: "${hookText.slice(0, 80)}"`
        : `Opens on a spoken line: "${hookText.slice(0, 80)}"`,
    },
    flow: {
      grade: grade(flowScore),
      score: flowScore,
      reason:
        durationSec >= 30 && durationSec <= 60
          ? `${Math.round(durationSec)}s is a tight, complete moment`
          : `${Math.round(durationSec)}s runs a little long for one moment`,
    },
    value: {
      grade: grade(valueScore),
      score: valueScore,
      reason: `Delivers a concrete point from the transcript (${Math.min(200, bodyText.length)} chars of speech)`,
    },
    trend: {
      grade: grade(trendScore),
      score: trendScore,
      reason:
        trendScore >= 60
          ? "Topic and phrasing match short-form patterns that travel well"
          : "Solid moment, but the phrasing is niche rather than broadly shareable",
    },
    total: Math.max(40, Math.min(99, total)),
  };
}

function titleFrom(text: string): string {
  const clean = text.replace(/[.!?]+$/, "").trim();
  const capped = clean.charAt(0).toUpperCase() + clean.slice(1);
  return capped.length > 80 ? capped.slice(0, 77) + "…" : capped;
}

/**
 * Pick up to `maxClips` non-overlapping clips (30–60s) from the transcript.
 * `energyAt` reports audio energy for a time window (0..1) when available.
 */
export function buildClips(
  segments: Segment[],
  energyAt?: (start: number, end: number) => number,
  maxClips = 8,
): Clip[] {
  if (segments.length === 0) return [];
  // Candidate windows: start at a segment boundary, run 30-60s.
  type Cand = { start: number; end: number; score: number; segs: Segment[]; cues: string[] };
  const cands: Cand[] = [];
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].start;
    let end = start;
    const segs: Segment[] = [];
    let textLen = 0;
    for (let j = i; j < segments.length && segments[j].start < start + 60; j++) {
      segs.push(segments[j]);
      end = segments[j].end;
      textLen += segments[j].text.length;
      if (end - start >= 30 && textLen > 60) {
        const first = lineScore(segs[0].text);
        const energy = energyAt ? energyAt(start, end) : 0.5;
        const cues = [...first.cues];
        if (energy > 0.6) cues.push("high speech energy");
        cands.push({ start, end, score: first.score + energy * 25 + segs.length, segs: [...segs], cues });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked: Cand[] = [];
  for (const c of cands) {
    if (picked.length >= maxClips) break;
    if (picked.some((p) => c.start < p.end - 5 && c.end > p.start + 5)) continue;
    picked.push(c);
  }
  picked.sort((a, b) => b.score - a.score);
  return picked.map((c, idx) => {
    const hookText = c.segs[0].text;
    const bodyText = c.segs.map((s) => s.text).join(" ");
    const energy = energyAt ? energyAt(c.start, c.end) : 0.5;
    const scores = makeScores(hookText, bodyText, c.end - c.start, energy);
    return {
      id: `clip-${idx + 1}`,
      start: c.start,
      end: c.end,
      title: titleFrom(hookText),
      description: bodyText.slice(0, 220),
      hook: hookText,
      scores,
      reason: c.cues.length
        ? `Picked because it ${c.cues.join(" and ")}`
        : "Picked as a complete spoken moment",
      segments: c.segs,
    };
  });
}

/** Split a segment's text into word timings across its duration. */
export function wordTimings(seg: Segment): { word: string; start: number; end: number }[] {
  const ws = seg.text.split(/\s+/).filter(Boolean);
  if (ws.length === 0) return [];
  const dur = Math.max(0.2, seg.end - seg.start);
  const per = dur / ws.length;
  return ws.map((w, i) => ({
    word: w,
    start: seg.start + i * per,
    end: seg.start + (i + 1) * per,
  }));
}
