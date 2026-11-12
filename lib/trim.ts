// Trimmer helpers (pure, unit-testable): pick one part of a long video and
// generate clips from that part only. All times are seconds on the ORIGINAL
// video timeline, so clips, captions and scores point at the right moments.

export type TrimPart = { start: number; end: number };

export const DEFAULT_PART_SECONDS = 600; // 10 minutes
export const MIN_PART_SECONDS = 5;

/** Parse "90", "1:30", "1:30.5" or "1:02:30" into seconds. Null when invalid. */
export function parseTimecode(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^-/.test(raw)) return null;
  const parts = raw.split(":");
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  if (parts.length > 1) {
    // In colon form, minutes/seconds fields must be < 60 (except hours).
    for (let i = 1; i < nums.length; i++) if (nums[i] >= 60) return null;
  }
  let total = 0;
  for (const n of nums) total = total * 60 + n;
  return total;
}

/** Format seconds as "M:SS" (e.g. 125 -> "2:05"). */
export function formatTimecode(t: number): string {
  const clamped = Math.max(0, Math.floor(t));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Clamp a requested part into [0, duration] with a minimum length. */
export function clampPart(start: number, end: number, duration: number): TrimPart {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };
  const minLen = Math.min(MIN_PART_SECONDS, duration);
  let s = Math.min(Math.max(0, start), Math.max(0, duration - minLen));
  let e = Math.min(Math.max(s + minLen, end), duration);
  if (e - s < minLen) {
    s = Math.max(0, e - minLen);
    e = Math.min(duration, s + minLen);
  }
  return { start: s, end: e };
}

/** The next part after `current` (same length by default): e.g. 10:00-20:00 after 0:00-10:00. */
export function nextPart(current: TrimPart, duration: number, len = DEFAULT_PART_SECONDS): TrimPart {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };
  let s = current.end;
  if (s >= duration - 30) s = Math.max(0, duration - len);
  return clampPart(s, s + len, duration);
}

/** Label for a saved job, e.g. "part 20:00–30:00" or "whole video". */
export function partLabel(part: TrimPart | null | undefined, duration: number): string {
  if (!part) return "whole video";
  if (part.start <= 0 && part.end >= duration - 0.5) return "whole video";
  return `part ${formatTimecode(part.start)}–${formatTimecode(part.end)}`;
}
