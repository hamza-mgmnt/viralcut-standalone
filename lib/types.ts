// Shared types for the standalone ViralCut clone.

export type Segment = {
  start: number; // seconds
  end: number; // seconds
  text: string;
};

export type ScoreFactor = {
  grade: "A" | "B" | "C";
  score: number; // 0-100
  reason: string;
};

export type Scores = {
  hook: ScoreFactor;
  flow: ScoreFactor;
  value: ScoreFactor;
  trend: ScoreFactor;
  total: number; // 0-99
};

export type Clip = {
  id: string;
  start: number;
  end: number;
  title: string;
  description: string;
  hook: string;
  scores: Scores;
  reason: string; // one-line real reason this moment was picked
  segments: Segment[];
};

export type CaptionStyleId =
  | "hormozi"
  | "beast"
  | "karaoke"
  | "pop"
  | "neon"
  | "highlighter"
  | "impact"
  | "fire"
  | "clean"
  | "outline"
  | "minimal"
  | "shadow";

export type CaptionSettings = {
  enabled: boolean;
  style: CaptionStyleId;
  size: "S" | "M" | "L" | "XL";
  position: "Bottom" | "Middle" | "Top";
};

export type ReframeMode = "auto" | "left" | "right" | "custom";

export type SpeakerTurn = {
  start: number;
  end: number;
  /** Horizontal centre of the speaking person in this turn, 0..1 of frame width. */
  x: number;
  /** Which side of the frame the speaker is on, for the badge. */
  side: "left" | "right";
  /** True when this turn starts right after an edit cut. */
  cut: boolean;
};

export type BrainStatus = "idle" | "working" | "online" | "unavailable";

export type BrainResult = {
  modelUsed: string;
  /** Per-spoken-turn speaker positions, decided per shot. */
  turns: SpeakerTurn[];
  /** Clip picks by meaning: start/end in seconds, title, reason. */
  picks: { start: number; end: number; title: string; reason: string }[];
  /** Caption corrections: original phrase -> corrected phrase. */
  corrections: { from: string; to: string }[];
  /** Words to highlight in gold. */
  highlightWords: string[];
  /** Per-factor score explanations keyed by clip title. */
  scoreReasons: Record<string, { hook: string; flow: string; value: string; trend: string }>;
  error?: string;
};

export type Job = {
  id: string;
  fileName: string;
  durationSec: number;
  createdAt: string;
  segments: Segment[];
  clips: Clip[];
  /** When set, this job was generated from one trimmed part only (original-video seconds). */
  rangeStartSec?: number;
  rangeEndSec?: number;
};

export const CAPTION_STYLE_NAMES: Record<CaptionStyleId, string> = {
  hormozi: "Hormozi",
  beast: "Beast Mode",
  karaoke: "Karaoke",
  pop: "Pop Pill",
  neon: "Neon Glow",
  highlighter: "Highlighter",
  impact: "Bold Impact",
  fire: "Fire",
  clean: "Clean Box",
  outline: "Outline",
  minimal: "Minimal",
  shadow: "Shadow",
};

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: true,
  style: "hormozi",
  size: "M",
  position: "Bottom",
};
