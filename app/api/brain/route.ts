// POST /api/brain
// Gemini AI Brain: one analysis call per request (keeps Vercel Hobby
// functions fast). Body: { frames: [{t, jpeg data URL}], segments, durationSec }.
// Gemini watches the frames + transcript and returns per-spoken-turn speaker
// positions, meaning-based clip picks, hooks, score reasons, caption
// corrections and highlight words. Falls back across newer Flash models;
// NEVER gemini-2.5-flash (404 for this user's new key).

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-flash-latest"];

type FrameIn = { t: number; jpeg: string };
type SegmentIn = { start: number; end: number; text: string };

function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Gemini did not return JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        error:
          "GEMINI_API_KEY is not set on the server. Add it in the Vercel dashboard (Settings > Environment Variables) and redeploy. The site will use its built-in camera, scores and titles until then.",
      },
      { status: 503 },
    );
  }
  let body: { frames?: FrameIn[]; segments?: SegmentIn[]; durationSec?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body { frames, segments, durationSec }." }, { status: 400 });
  }
  const frames = (body.frames ?? []).slice(0, 48);
  const segments = body.segments ?? [];
  const durationSec = body.durationSec ?? 0;
  if (frames.length === 0 || segments.length === 0) {
    return NextResponse.json({ error: "Need at least one frame and one transcript segment." }, { status: 400 });
  }

  const transcript = segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join("\n");
  const prompt = `You are the AI brain of a video-clipping app. You are given ${frames.length} sampled frames (each labelled with its timestamp) and the full transcript of a ${Math.round(durationSec)}s video.

TRANSCRIPT:
${transcript}

Decide, per SPOKEN TURN (each transcript line is roughly one turn):
- who is speaking and where they sit in THAT shot, as x = horizontal centre of the speaker, 0 = far left, 1 = far right. The same person can sit at a DIFFERENT x in a different camera angle (wide shot vs close-up) — decide per turn, never average positions across a shot. If only one person is visible in a frame, x is that person's centre.
- whether the turn starts right after an edit cut (cut: true) or inside the same shot (cut: false).

Also pick the 3-5 most viral moments by MEANING (funny, surprising, emotional, useful), each with start/end seconds, a title taken from the actual spoken words, and a one-line real reason.

Also: correct any misheard transcript words (list original -> corrected), list up to 10 punchy words to highlight, and give one-line Hook/Flow/Value/Trend reasons for each pick.

Reply with ONLY strict JSON, no markdown, in this shape:
{"turns":[{"start":0,"end":4,"x":0.17,"side":"left","cut":false}],"picks":[{"start":0,"end":42,"title":"...","reason":"..."}],"corrections":[{"from":"...","to":"..."}],"highlightWords":["..."],"scoreReasons":{"<pick title>":{"hook":"...","flow":"...","value":"...","trend":"..."}}}`;

  const parts: unknown[] = [{ text: prompt }];
  for (const f of frames) {
    parts.push({ text: `Frame at ${f.t.toFixed(1)}s:` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: stripDataUrl(f.jpeg) } });
  }

  let lastError = "";
  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }] }),
        },
      );
      if (!res.ok) {
        lastError = `${model}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
        if (res.status === 404 || res.status === 503 || res.status === 429) continue;
        return NextResponse.json({ error: `Gemini request failed. ${lastError}` }, { status: 502 });
      }
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "")
        .join("");
      if (!text) {
        lastError = `${model}: empty response`;
        continue;
      }
      const parsed = extractJson(text) as Record<string, unknown>;
      return NextResponse.json({ ...parsed, modelUsed: model });
    } catch (e) {
      lastError = `${model}: ${e instanceof Error ? e.message : "request failed"}`;
    }
  }
  return NextResponse.json(
    {
      error:
        `Gemini is unavailable right now (tried ${MODELS.join(", ")}). Last error: ${lastError}. The site will use its built-in camera, scores and titles until the brain is reachable again.`,
    },
    { status: 503 },
  );
}
