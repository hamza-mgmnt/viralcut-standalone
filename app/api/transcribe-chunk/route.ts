// POST /api/transcribe-chunk
// One 2-minute WAV chunk per call (keeps Vercel Hobby functions fast).
// Body: multipart form-data with `file` (audio/wav) and optional `language`.
// Returns Groq Whisper verbose_json segments for that chunk.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set on the server. Add it in the Vercel dashboard (Settings > Environment Variables) and redeploy." },
      { status: 503 },
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form-data with a `file` field." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing audio chunk in `file` field." }, { status: 400 });
  }
  const language = form.get("language");
  const out = new FormData();
  out.append("file", file, "chunk.wav");
  out.append("model", "whisper-large-v3-turbo");
  out.append("response_format", "verbose_json");
  if (typeof language === "string" && language) out.append("language", language);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: out,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Groq transcription failed (${res.status}). ${text.slice(0, 300)}` },
      { status: res.status === 413 ? 413 : 502 },
    );
  }
  const data = await res.json();
  const segments = (data.segments ?? []).map((s: { start: number; end: number; text: string }) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  return NextResponse.json({ segments, text: data.text ?? "" });
}
