# ViralCut Clone — Standalone (Vercel)

Free video-clipping web app, rebuilt as a standalone Next.js (App Router,
TypeScript, Tailwind) project so it can be deployed to Vercel's free Hobby
tier and opened from a public link.

## What it does

- Upload an MP4 (file input or drag-drop). Audio is decoded in the browser
  to 16 kHz mono and sent to **Groq Whisper** (`whisper-large-v3-turbo`) in
  2-minute chunks (~3.8 MB each, under Groq's 25 MB limit). Transcripts are
  stitched with correct timestamps and shown in a transcript panel.
- Clips, titles, descriptions and Hook/Flow/Value/Trend scores are built from
  the real transcript, never invented hooks. Clip picks prefer meaning
  (funny, surprising, emotional, useful) with a one-line real reason.
- **Gemini AI Brain** (`gemini-3.5-flash-lite` default, falls back to other
  newer Flash models; never `gemini-2.5-flash`, which returns 404 for this
  key): watches sampled video frames plus the transcript and returns
  per-spoken-turn speaker positions, meaning-based picks, hooks, score
  reasons, caption corrections and highlight words. An AI Brain status panel
  shows Ready / Working / Online + model used; when Gemini is unavailable or
  its free quota is used up, the site falls back to the built-in heuristic
  camera, scores and titles instead of failing.
- **Shot-aware active-speaker reframe**: detects edit cuts, decides framing
  inside each shot from that shot's own faces or sustained head motion during
  each spoken line, and in a wide two-person shot decides **per spoken turn**
  who is speaking and frames them — it never averages speaker positions into
  one fixed centre per shot. Hold rule against flicker. Camera glides:
  ~0.3s at a cut, ~0.8s pan inside a shot. Preview badge
  ("Speaker: Left/Right person · Auto") and Auto / Left / Right / Custom
  override per clip. Preview, thumbnails and export share the same track.
- **Captions**: 12 viral styles (Hormozi default, Beast Mode, Karaoke, Pop
  Pill, Neon Glow, Highlighter, Bold Impact, Fire, Clean Box, Outline,
  Minimal, Shadow), size S/M/L/XL, position Bottom/Middle/Top, live picker
  in Settings and in the clip editor. Word-by-word captions from the
  transcript with the spoken word highlighted. Captions on/off toggle in
  Settings and per clip; off means no captions in preview or burned into
  exports; on by default; style choice remembered.
- **Trimmer**: after uploading, "Trim — use only part of the video" lets you
  pick one part (sliders, time boxes like 20:00, "set at playhead", Play this
  part, and First 10 minutes / Next 10-minute part / Whole video quick
  picks). Generate then transcribes, scans and analyses only that part, and
  clips, captions and scores keep the ORIGINAL video's times, so a 50-minute
  video can be worked through 10 minutes at a time. Saved jobs show which
  part they came from (e.g. "part 20:00–30:00"). When Trim is on, only the
  chosen part's audio is decoded (see "How audio is decoded" below); the
  full file is never decoded just to throw most of it away.
- Clip editor (reframe override, caption style), clip thumbnails, 9:16 / 1:1 /
  16:9 framing, export via canvas + MediaRecorder (WebM). Jobs and
  transcripts are stored in browser localStorage (no database server).

## How audio is decoded

Three decode paths, tried in order by `lib/decode.ts`. Every path returns
the same shape — a full-length 16 kHz mono buffer with silence outside the
trimmed part — so chunking, scoring and transcripts all keep absolute
video time. The UI shows which path produced the audio
("Audio: trimmed range only (streaming)" / "Audio: full decode" /
"Audio: fallback decoder").

1. **Streaming range decode** (`lib/range-decode.ts`, Trim ON only):
   mp4box.js + WebCodecs `AudioDecoder`. The file is read in 1 MB slices;
   mp4box's `appendBuffer` return value jumps straight to the moov box
   (even when moov is at the end of the file), `seek()` jumps to the part
   start, and only in-range audio samples are decoded. Feeding stops once
   sample times pass the part end. On a 65 MB / 50-minute test file, a
   10-minute part reads ~26% of the file and memory stays bounded
   (no `keepMdatData`, used samples released per batch). The AAC decoder
   config is built from the observed track (codec string, sample rate,
   channel count, esds bytes) and checked with
   `AudioDecoder.isConfigSupported`. Pure helpers (AAC config, WAV parsing,
   downmix/resample/placement) live in `lib/pcm.ts` and are unit-tested.
2. **Full decode** (`lib/audio.ts` `decodeAudioToMono16k`): the browser's
   `decodeAudioData` on the whole file. This is the first path when Trim
   is OFF, and the fallback when streaming decode fails.
3. **ffmpeg.wasm fallback** (`lib/ffmpeg-decode.ts`, last resort only):
   for files whose audio codec Chrome cannot decode at all (e.g. AC-3).
   The single-thread core (`@ffmpeg/core` 0.12.9 — verified to contain no
   SharedArrayBuffer/pthread use, so it needs no COOP/COEP headers) loads
   from the jsDelivr CDN at runtime via `toBlobURL`, with download
   progress shown. First use downloads ~30 MB (ffmpeg-core.wasm is
   32.2 MB); the core then stays loaded for the session. ffmpeg seeks
   before the input (`-ss <start> -t <length> -i …`) so only the part is
   decoded, and outputs 16 kHz mono WAV. No `.wasm` is bundled by Next.js;
   the ffmpeg worker is bundled as its own chunk by webpack.

Limits, stated plainly:

- The ffmpeg path still loads the whole file's bytes into wasm memory
  (`writeFile`), so an extremely large file can exhaust wasm memory even
  when only a part is decoded.
- Browsers without WebCodecs (`AudioDecoder`) skip the streaming path and
  go straight to full decode, then the ffmpeg fallback.
- Fragmented MP4s (`isFragmented`) are not supported by the streaming path
  (untested) — they fall through to full decode / ffmpeg.
- The streaming path is AAC-first: other codecs are attempted without a
  description and fall through when the browser reports no supported
  config. The ffmpeg fallback handles the codecs Chrome cannot.
- ffmpeg `-ss` output can start a fraction of a second off the exact seek
  point; AAC priming can shift streaming-decoded audio by a few tens of
  ms. Neither matters for transcription.

## Keys

No API key is in the code, repo, logs or docs — only key names in
`.env.example`. Both keys live server-side as environment variables:

- `GROQ_API_KEY` — Groq API key (free tier, no card).
- `GEMINI_API_KEY` — Gemini API key from Google AI Studio (free tier).

## Deploy to Vercel (free Hobby tier)

```bash
cd viralcut-standalone
npm install
npm run build        # must pass clean before deploying
```

1. Install the Vercel CLI and log in (free account):
   ```bash
   npm install -g vercel
   vercel login
   ```
2. Deploy:
   ```bash
   vercel --prod
   ```
   Answer the prompts (defaults are fine; framework is detected as Next.js).
3. Add the two environment variables in the Vercel dashboard:
   Project → Settings → Environment Variables → add `GROQ_API_KEY` and
   `GEMINI_API_KEY` (Production scope), then redeploy:
   ```bash
   vercel --prod
   ```
4. Open the public URL Vercel prints (e.g. `https://viralcut-standalone.vercel.app`).

## Local development

```bash
cp .env.example .env.local   # fill in your keys
npm install
npm run dev                  # http://localhost:3000
```

Without keys, the API routes return a clear JSON error saying the key is
missing (HTTP 503) instead of crashing:

```bash
curl -X POST http://localhost:3000/api/brain -H 'Content-Type: application/json' -d '{}'
curl -X POST http://localhost:3000/api/transcribe-chunk -F file=@chunk.wav
```

## Vercel limits to know about

- Every API route is one short call: one Groq chunk per request, one Gemini
  analysis per request; the client polls and stitches. No long-running
  server work.
- Hobby has monthly caps (bandwidth, function invocations) and a short
  per-request function timeout. The chunked/polling design fits inside it
  for personal use; heavy traffic can hit the caps until the month resets.
- The known hard case: a 144p interview where the same speaker sits at
  different x positions in different camera angles and faces are ~30px wide.
  The per-shot, per-turn framing above is built for exactly that.

## Project layout

- `app/page.tsx` — the whole studio: upload, settings, preview, clips, editor.
- `app/api/transcribe-chunk/route.ts` — one Groq Whisper chunk per call.
- `app/api/brain/route.ts` — one Gemini analysis per call, model fallback.
- `lib/audio.ts` — 16 kHz mono decode + 2-minute WAV chunking (whole file or one trimmed range).
- `lib/decode.ts` — decode fallback chain (streaming range → full → ffmpeg) + method labels.
- `lib/range-decode.ts` — streaming range decode (mp4box.js + WebCodecs), Trim ON only.
- `lib/ffmpeg-decode.ts` — ffmpeg.wasm fallback decoder (single-thread core from CDN).
- `lib/pcm.ts` — pure PCM helpers: AAC config, WAV parsing, downmix/resample/placement.
- `lib/webcodecs.d.ts` — minimal WebCodecs audio types (TS 5.5's DOM lib lacks them).
- `lib/trim.ts` — trimmer time parsing, part clamping, next-part and job labels.
- `lib/clips.ts` — transcript-grounded clip picks, titles, scores.
- `lib/speaker.ts` — shot-aware scan, per-turn decisions, focus glide.
- `lib/captions.ts` — 12 caption styles (CSS preview + canvas export).
- `lib/brain.ts` — frame sampling + brain client.
- `lib/exporter.ts` — canvas + MediaRecorder WebM export.
