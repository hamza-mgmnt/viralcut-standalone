"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rmsEnergy, sliceRangeIntoChunks } from "../lib/audio";
import { runBrain, sampleFrames } from "../lib/brain";
import { CAPTION_STYLES } from "../lib/captions";
import { buildClips, wordTimings } from "../lib/clips";
import { decodeAudio, DECODE_METHOD_LABELS } from "../lib/decode";
import { exportClip, type Aspect } from "../lib/exporter";
import {
  cropWidthFraction,
  focusAt,
  mergeBrainTurns,
  objectPosPct,
  scanSpeakerTrack,
} from "../lib/speaker";
import {
  clampPart,
  DEFAULT_PART_SECONDS,
  formatTimecode,
  nextPart,
  parseTimecode,
  partLabel,
} from "../lib/trim";
import type {
  BrainResult,
  BrainStatus,
  CaptionSettings,
  Clip,
  Job,
  ReframeMode,
  Segment,
  SpeakerTurn,
} from "../lib/types";
import { CAPTION_STYLE_NAMES, DEFAULT_CAPTIONS } from "../lib/types";

type Phase =
  | "idle"
  | "decoding"
  | "transcribing"
  | "scanning"
  | "brain"
  | "ready"
  | "error";

const JOBS_KEY = "viralcut-standalone-jobs-v1";
const CAPTIONS_KEY = "viralcut-standalone-captions-v1";

function loadJobs(): Job[] {
  try {
    return JSON.parse(localStorage.getItem(JOBS_KEY) ?? "[]") as Job[];
  } catch {
    return [];
  }
}

function loadCaptions(): CaptionSettings {
  try {
    const raw = localStorage.getItem(CAPTIONS_KEY);
    if (raw) return { ...DEFAULT_CAPTIONS, ...(JSON.parse(raw) as Partial<CaptionSettings>) };
  } catch {
    /* fall through */
  }
  return DEFAULT_CAPTIONS;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [duration, setDuration] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [decodeMethod, setDecodeMethod] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [turns, setTurns] = useState<SpeakerTurn[]>([]);
  const [captions, setCaptions] = useState<CaptionSettings>(DEFAULT_CAPTIONS);
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [reframe, setReframe] = useState<ReframeMode>("auto");
  const [customX, setCustomX] = useState(0.5);
  const [currentTime, setCurrentTime] = useState(0);
  const [brainStatus, setBrainStatus] = useState<BrainStatus>("idle");
  const [brainModel, setBrainModel] = useState("");
  const [brainError, setBrainError] = useState("");
  const [brainResult, setBrainResult] = useState<BrainResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [mono, setMono] = useState<Float32Array | null>(null);
  // Trimmer: generate clips from one part of a long video only.
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(DEFAULT_PART_SECONDS);
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("10:00");
  const previewEndRef = useRef<number | null>(null);

  useEffect(() => {
    setJobs(loadJobs());
    setCaptions(loadCaptions());
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(CAPTIONS_KEY, JSON.stringify(captions));
    } catch {
      /* ignore */
    }
  }, [captions]);

  const selected = useMemo(() => clips.find((c) => c.id === selectedId) ?? clips[0], [clips, selectedId]);
  const aspectSize = aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : "aspect-video";

  // The part Generate will actually process, clamped to the real duration.
  const effectivePart = useMemo(
    () => (trimEnabled && duration > 0 ? clampPart(trimStart, trimEnd, duration) : { start: 0, end: duration }),
    [trimEnabled, trimStart, trimEnd, duration],
  );

  const setPart = useCallback(
    (start: number, end: number) => {
      const part = duration > 0 ? clampPart(start, end, duration) : { start, end };
      setTrimStart(part.start);
      setTrimEnd(part.end);
      setStartText(formatTimecode(part.start));
      setEndText(formatTimecode(part.end));
    },
    [duration],
  );

  const commitTimeText = useCallback(
    (which: "start" | "end") => {
      const parsed = parseTimecode(which === "start" ? startText : endText);
      if (parsed == null) {
        // Invalid input: snap the box back to the current value.
        if (which === "start") setStartText(formatTimecode(trimStart));
        else setEndText(formatTimecode(trimEnd));
        return;
      }
      if (which === "start") setPart(parsed, trimEnd);
      else setPart(trimStart, parsed);
    },
    [startText, endText, trimStart, trimEnd, setPart],
  );

  const onFile = useCallback((f: File | undefined) => {
    if (!f) return;
    if (!/\.mp4$/i.test(f.name) && f.type !== "video/mp4") {
      setError("MP4 only — please drop an .mp4 file.");
      return;
    }
    setError("");
    setFile(f);
    setClips([]);
    setSegments([]);
    setTurns([]);
    setDecodeMethod("");
    setBrainResult(null);
    setBrainStatus("idle");
    setPhase("idle");
    setTrimEnabled(false);
    setTrimStart(0);
    setTrimEnd(DEFAULT_PART_SECONDS);
    setStartText("0:00");
    setEndText("10:00");
    setDuration(0);
    const url = URL.createObjectURL(f);
    setVideoUrl(url);
  }, []);

  const generate = useCallback(async () => {
    const video = videoRef.current;
    if (!file || !video) return;
    setError("");
    setDecodeMethod("");
    setPhase("decoding");
    setProgress("Reading audio…");
    try {
      // Trim: only the chosen part is transcribed, scanned and analysed.
      // Chunk offsets stay in ORIGINAL video time, so clips/captions/scores
      // point at the right moments of the full video.
      const fullDuration = video.duration || duration || 0;
      const part = trimEnabled ? clampPart(trimStart, trimEnd, fullDuration) : { start: 0, end: fullDuration };
      // Decode chain: streaming range decode (trim on) -> full decode ->
      // ffmpeg fallback. Returns a full-length buffer with silence outside
      // the part, so everything below keeps absolute video time.
      const decoded = await decodeAudio(
        file,
        fullDuration,
        trimEnabled ? part : null,
        (t) => setProgress(t),
      );
      const samples = decoded.samples;
      setDecodeMethod(DECODE_METHOD_LABELS[decoded.method]);
      setMono(samples);
      const chunks = sliceRangeIntoChunks(samples, part.start, part.end);
      if (chunks.length === 0) throw new Error("That trimmed part has no audio to transcribe.");
      const all: Segment[] = [];
      setPhase("transcribing");
      for (let i = 0; i < chunks.length; i++) {
        setProgress(`Transcribing chunk ${i + 1} of ${chunks.length}…`);
        const form = new FormData();
        form.append("file", chunks[i].blob, "chunk.wav");
        const res = await fetch("/api/transcribe-chunk", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`);
        for (const s of data.segments as Segment[]) {
          all.push({ start: s.start + chunks[i].startSec, end: s.end + chunks[i].startSec, text: s.text });
        }
      }
      all.sort((a, b) => a.start - b.start);
      setSegments(all);
      if (all.length === 0) throw new Error("No speech was transcribed from this video.");

      // Shot-aware speaker scan (built-in fallback track).
      setPhase("scanning");
      setProgress("Scanning speakers…");
      const scan = await scanSpeakerTrack(
        video,
        all,
        (p) => setProgress(`Scanning speakers… ${Math.round(p * 100)}%`),
        trimEnabled ? part : undefined,
      );
      let finalTurns = scan;
      setTurns(scan);

      // Gemini AI Brain (optional — falls back gracefully).
      setPhase("brain");
      setBrainStatus("working");
      setProgress("AI Brain is watching the video…");
      const frames = await sampleFrames(video, 2, 48, trimEnabled ? part : undefined);
      const brain = await runBrain(frames, all, video.duration, (s, model, err) => {
        setBrainStatus(s);
        if (model) setBrainModel(model);
        if (err) setBrainError(err);
      });
      let corrected = all;
      if (brain) {
        setBrainResult(brain);
        if (brain.turns?.length) {
          finalTurns = mergeBrainTurns(
            brain.turns.map((t) => ({ ...t, cut: t.cut ?? false })),
            scan,
          );
          setTurns(finalTurns);
        }
        if (brain.corrections?.length) {
          corrected = all.map((s) => {
            let text = s.text;
            for (const c of brain.corrections) text = text.split(c.from).join(c.to);
            return { ...s, text };
          });
          setSegments(corrected);
        }
      }

      // Clips from the real transcript.
      const energyAt = (a: number, b: number) => rmsEnergy(samples, a, b);
      let made = buildClips(corrected, energyAt);
      if (brain?.picks?.length) {
        // Prefer Gemini's meaning-based picks for titles/reasons.
        made = made.map((clip) => {
          const pick = brain.picks.find((p) => clip.start < p.end - 3 && clip.end > p.start + 3);
          if (!pick) return clip;
          const reasons = brain.scoreReasons?.[pick.title];
          return {
            ...clip,
            title: pick.title,
            reason: pick.reason,
            scores: reasons
              ? {
                  ...clip.scores,
                  hook: { ...clip.scores.hook, reason: reasons.hook },
                  flow: { ...clip.scores.flow, reason: reasons.flow },
                  value: { ...clip.scores.value, reason: reasons.value },
                  trend: { ...clip.scores.trend, reason: reasons.trend },
                }
              : clip.scores,
          };
        });
      }
      setClips(made);
      if (made[0]) setSelectedId(made[0].id);
      const job: Job = {
        id: `job-${Date.now()}`,
        fileName: file.name,
        durationSec: video.duration,
        createdAt: new Date().toISOString(),
        segments: corrected,
        clips: made,
        rangeStartSec: part.start,
        rangeEndSec: part.end,
      };
      const next = [job, ...loadJobs()].slice(0, 10);
      try {
        localStorage.setItem(JOBS_KEY, JSON.stringify(next));
      } catch {
        /* storage full — ignore */
      }
      setJobs(next);
      setPhase("ready");
      setProgress("");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Generate failed.");
      setProgress("");
    }
  }, [file, trimEnabled, trimStart, trimEnd, duration]);

  const currentTurn = useMemo(() => {
    if (!turns.length) return null;
    let cur = turns[0];
    for (const t of turns) if (currentTime >= t.start) cur = t;
    return cur;
  }, [turns, currentTime]);

  const focus = useMemo(() => {
    if (reframe === "left") return 0.22;
    if (reframe === "right") return 0.78;
    if (reframe === "custom") return customX;
    return focusAt(turns, currentTime, 0.5);
  }, [reframe, customX, turns, currentTime]);

  const cropFrac = useMemo(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return 0.32;
    const [ow, oh] = aspect === "9:16" ? [9, 16] : aspect === "1:1" ? [1, 1] : [16, 9];
    return cropWidthFraction(v.videoWidth, v.videoHeight, ow, oh);
  }, [aspect, duration]);

  const activeWords = useMemo(() => {
    if (!selected) return [] as { word: string; start: number; end: number; current: boolean }[];
    const ws = selected.segments.flatMap((s) => wordTimings(s));
    return ws
      .filter((w) => Math.abs(w.start - currentTime) < 1.4)
      .slice(0, 8)
      .map((w) => ({ ...w, current: currentTime >= w.start && currentTime < w.end + 0.15 }));
  }, [selected, currentTime]);

  const doExport = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !selected) return;
    setExporting(true);
    try {
      const blob = await exportClip(
        video,
        selected,
        turns,
        captions,
        aspect,
        brainResult?.highlightWords ?? [],
        (p) => setProgress(`Exporting… ${Math.round(p * 100)}%`),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `viralcut-${selected.id}-score${selected.scores.total}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
      setProgress("");
    }
  }, [selected, turns, captions, aspect, brainResult]);

  const highlightSet = useMemo(
    () => new Set((brainResult?.highlightWords ?? []).map((w) => w.toLowerCase())),
    [brainResult],
  );

  return (
    <main className="max-w-6xl mx-auto px-4 py-6">
      <header className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-3xl font-black tracking-tight">
          ViralCut <span className="text-accent">Clone</span>
        </h1>
        <span className="text-xs bg-panel border border-white/10 rounded-full px-3 py-1">
          Free · No payment · MP4 only
        </span>
        <span
          className={`text-xs rounded-full px-3 py-1 border ${
            brainStatus === "online"
              ? "bg-green-900/40 border-green-500/40"
              : brainStatus === "working"
                ? "bg-yellow-900/40 border-yellow-500/40"
                : brainStatus === "unavailable"
                  ? "bg-red-900/40 border-red-500/40"
                  : "bg-panel border-white/10"
          }`}
          title={brainError || "Gemini AI Brain status"}
        >
          AI Brain:{" "}
          {brainStatus === "online"
            ? `Online (${brainModel})`
            : brainStatus === "working"
              ? "Working…"
              : brainStatus === "unavailable"
                ? "Unavailable — using built-in camera"
                : "Ready"}
        </span>
      </header>

      {brainError && (
        <p className="mb-4 text-sm bg-red-950/60 border border-red-500/30 rounded-lg px-4 py-3">
          AI Brain unavailable: {brainError}
        </p>
      )}
      {error && (
        <p className="mb-4 text-sm bg-red-950/60 border border-red-500/30 rounded-lg px-4 py-3">{error}</p>
      )}

      {/* Upload */}
      <section
        className={`border-2 border-dashed rounded-2xl p-8 text-center mb-6 ${
          dragOver ? "border-accent bg-accent/10" : "border-white/20 bg-panel"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFile(e.dataTransfer.files?.[0]);
        }}
      >
        <p className="text-lg font-bold">Drop an MP4 here, or</p>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,.mp4"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="mt-3 bg-accent hover:bg-orange-600 text-white font-bold px-6 py-3 rounded-full"
        >
          Choose MP4
        </button>
        {file && (
          <p className="mt-3 text-sm text-white/70">
            {file.name} · {fmt(duration)} · {(file.size / 1e6).toFixed(1)} MB
          </p>
        )}
        <p className="mt-2 text-xs text-white/50">
          Audio is decoded in your browser to 16 kHz mono and sent to Groq Whisper in 2-minute chunks.
          Video never leaves your device except the audio chunks and sampled frames.
        </p>
      </section>

      {/* Trimmer — use only part of the video */}
      {file && (
        <section className="bg-panel border border-white/10 rounded-2xl p-4 mb-6">
          <label className="flex items-center gap-2 font-bold">
            <input
              type="checkbox"
              checked={trimEnabled}
              onChange={(e) => {
                const on = e.target.checked;
                setTrimEnabled(on);
                if (on) setPart(0, DEFAULT_PART_SECONDS);
              }}
              className="w-5 h-5 accent-orange-500"
            />
            Trim — use only part of the video
          </label>
          {trimEnabled && (
            <div className="mt-3">
              <p className="text-sm text-white/70 mb-3">
                Only this part is transcribed and clipped:{" "}
                <span className="text-white font-bold">
                  {formatTimecode(effectivePart.start)} – {formatTimecode(effectivePart.end)}
                </span>{" "}
                of {formatTimecode(duration)}. Clips keep the original video&apos;s times.
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-white/70 mb-1">Start</p>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(duration))}
                    step={1}
                    value={Math.floor(effectivePart.start)}
                    onChange={(e) => setPart(parseFloat(e.target.value), trimEnd)}
                    className="w-full"
                  />
                  <div className="flex gap-2 mt-1">
                    <input
                      type="text"
                      value={startText}
                      onChange={(e) => setStartText(e.target.value)}
                      onBlur={() => commitTimeText("start")}
                      onKeyDown={(e) => e.key === "Enter" && commitTimeText("start")}
                      className="w-24 bg-black/40 border border-white/20 rounded-lg px-2 py-1 text-sm font-mono"
                      aria-label="Trim start time"
                    />
                    <button
                      onClick={() => {
                        const v = videoRef.current;
                        if (v) setPart(v.currentTime, trimEnd);
                      }}
                      className="px-3 py-1 rounded-full text-xs border border-white/20"
                    >
                      Set at playhead
                    </button>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-white/70 mb-1">End</p>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(duration))}
                    step={1}
                    value={Math.floor(effectivePart.end)}
                    onChange={(e) => setPart(trimStart, parseFloat(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex gap-2 mt-1">
                    <input
                      type="text"
                      value={endText}
                      onChange={(e) => setEndText(e.target.value)}
                      onBlur={() => commitTimeText("end")}
                      onKeyDown={(e) => e.key === "Enter" && commitTimeText("end")}
                      className="w-24 bg-black/40 border border-white/20 rounded-lg px-2 py-1 text-sm font-mono"
                      aria-label="Trim end time"
                    />
                    <button
                      onClick={() => {
                        const v = videoRef.current;
                        if (v) setPart(trimStart, v.currentTime);
                      }}
                      className="px-3 py-1 rounded-full text-xs border border-white/20"
                    >
                      Set at playhead
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                <button
                  onClick={() => setPart(0, DEFAULT_PART_SECONDS)}
                  className="px-3 py-1 rounded-full text-xs border border-white/20"
                >
                  First 10 minutes
                </button>
                <button
                  onClick={() => {
                    const next = nextPart(effectivePart, duration);
                    setPart(next.start, next.end);
                  }}
                  className="px-3 py-1 rounded-full text-xs border border-white/20"
                >
                  Next 10-minute part
                </button>
                <button
                  onClick={() => setPart(0, duration)}
                  className="px-3 py-1 rounded-full text-xs border border-white/20"
                >
                  Whole video
                </button>
                <button
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    previewEndRef.current = effectivePart.end;
                    v.currentTime = effectivePart.start;
                    v.play().catch(() => undefined);
                  }}
                  className="px-3 py-1 rounded-full text-xs bg-accent border border-accent font-bold"
                >
                  Play this part
                </button>
              </div>
              <p className="text-xs text-white/50 mt-3">
                Work through a long video 10 minutes at a time: generate one part, then pick the next
                part and generate again. Type times like 20:00 in the boxes.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Settings */}
      <section className="bg-panel border border-white/10 rounded-2xl p-4 mb-6">
        <h2 className="font-bold mb-3">Settings</h2>
        <div className="flex flex-wrap gap-6 items-start">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={captions.enabled}
              onChange={(e) => setCaptions({ ...captions, enabled: e.target.checked })}
              className="w-5 h-5 accent-orange-500"
            />
            Captions on/off
          </label>
          <div className="text-sm">
            <p className="mb-1 text-white/70">Caption style</p>
            <div className="flex flex-wrap gap-1">
              {(Object.keys(CAPTION_STYLE_NAMES) as (keyof typeof CAPTION_STYLE_NAMES)[]).map((id) => (
                <button
                  key={id}
                  onClick={() => setCaptions({ ...captions, style: id })}
                  className={`px-2 py-1 rounded-full text-xs border ${
                    captions.style === id ? "bg-accent border-accent" : "border-white/20"
                  }`}
                >
                  {CAPTION_STYLE_NAMES[id]}
                </button>
              ))}
            </div>
          </div>
          <div className="text-sm">
            <p className="mb-1 text-white/70">Size</p>
            <div className="flex gap-1">
              {(["S", "M", "L", "XL"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setCaptions({ ...captions, size: s })}
                  className={`px-3 py-1 rounded-full text-xs border ${
                    captions.size === s ? "bg-accent border-accent" : "border-white/20"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mb-1 mt-3 text-white/70">Position</p>
            <div className="flex gap-1">
              {(["Bottom", "Middle", "Top"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCaptions({ ...captions, position: p })}
                  className={`px-3 py-1 rounded-full text-xs border ${
                    captions.position === p ? "bg-accent border-accent" : "border-white/20"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="text-sm">
            <p className="mb-1 text-white/70">Frame</p>
            <div className="flex gap-1">
              {(["9:16", "1:1", "16:9"] as Aspect[]).map((a) => (
                <button
                  key={a}
                  onClick={() => setAspect(a)}
                  className={`px-3 py-1 rounded-full text-xs border ${
                    aspect === a ? "bg-accent border-accent" : "border-white/20"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          onClick={generate}
          disabled={!file || phase === "decoding" || phase === "transcribing" || phase === "scanning" || phase === "brain"}
          className="mt-4 bg-accent hover:bg-orange-600 disabled:opacity-40 text-white font-bold px-8 py-3 rounded-full"
        >
          {phase === "idle" || phase === "ready" || phase === "error" ? "Generate clips" : progress || "Working…"}
        </button>
        {progress && phase !== "idle" && <p className="mt-2 text-sm text-white/60">{progress}</p>}
        {decodeMethod && <p className="mt-2 text-xs text-white/60">{decodeMethod}</p>}
      </section>

      <div className="grid md:grid-cols-5 gap-6">
        {/* Studio preview */}
        <section className="md:col-span-2">
          <h2 className="font-bold mb-3">Studio</h2>
          <div className={`relative mx-auto w-full max-w-[360px] ${aspectSize} bg-black rounded-2xl overflow-hidden border border-white/10`}>
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                className="absolute inset-0 w-full h-full"
                style={{
                  objectFit: "cover",
                  objectPosition: `${objectPosPct(focus, cropFrac)}% 50%`,
                }}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setCurrentTime(t);
                  if (previewEndRef.current != null && t >= previewEndRef.current) {
                    previewEndRef.current = null;
                    e.currentTarget.pause();
                  }
                }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm px-6 text-center">
                Upload an MP4 to preview clips here
              </div>
            )}
            {videoUrl && currentTurn && (
              <span className="absolute top-2 left-2 text-xs bg-black/70 rounded-full px-2 py-1">
                ● Speaker: {currentTurn.side === "left" ? "Left" : "Right"} person · Auto
              </span>
            )}
            {videoUrl && captions.enabled && activeWords.length > 0 && (
              <div
                className="absolute left-0 right-0 text-center px-3 pointer-events-none"
                style={{
                  top: captions.position === "Top" ? "12%" : captions.position === "Middle" ? "46%" : "78%",
                }}
              >
                {activeWords.map((w, i) => (
                  <span
                    key={`${w.start}-${i}`}
                    className="text-xl font-black leading-tight"
                    style={CAPTION_STYLES[captions.style].css(
                      w.current || highlightSet.has(w.word.toLowerCase().replace(/[^a-z']/g, "")),
                    )}
                  >
                    {w.word}{" "}
                  </span>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <div className="mt-4 bg-panel border border-white/10 rounded-2xl p-4">
              <h3 className="font-bold mb-2">Clip editor</h3>
              <p className="text-sm text-white/70 mb-3">
                {fmt(selected.start)} – {fmt(selected.end)} · score {selected.scores.total}
              </p>
              <p className="text-sm mb-1 text-white/70">Reframe</p>
              <div className="flex flex-wrap gap-1 mb-3">
                {(["auto", "left", "right", "custom"] as ReframeMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setReframe(m)}
                    className={`px-3 py-1 rounded-full text-xs border capitalize ${
                      reframe === m ? "bg-accent border-accent" : "border-white/20"
                    }`}
                  >
                    {m === "auto" ? "Auto" : m === "left" ? "Left person" : m === "right" ? "Right person" : "Custom"}
                  </button>
                ))}
              </div>
              {reframe === "custom" && (
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.01}
                  value={customX}
                  onChange={(e) => setCustomX(parseFloat(e.target.value))}
                  className="w-full mb-3"
                />
              )}
              <label className="flex items-center gap-2 text-sm mb-3">
                <input
                  type="checkbox"
                  checked={captions.enabled}
                  onChange={(e) => setCaptions({ ...captions, enabled: e.target.checked })}
                  className="w-5 h-5 accent-orange-500"
                />
                Captions on this clip
              </label>
              <button
                onClick={doExport}
                disabled={exporting}
                className="bg-gold text-black font-bold px-6 py-2 rounded-full disabled:opacity-40"
              >
                {exporting ? "Exporting…" : "Export clip (WebM)"}
              </button>
            </div>
          )}
        </section>

        {/* Clips + transcript */}
        <section className="md:col-span-3">
          <h2 className="font-bold mb-3">Clips {clips.length > 0 && `(${clips.length})`}</h2>
          {clips.length === 0 && (
            <p className="text-sm text-white/50 bg-panel border border-white/10 rounded-2xl p-4">
              No clips yet. Upload an MP4 and press Generate clips — clips, titles and scores are built
              from the real transcript, never invented.
            </p>
          )}
          <div className="space-y-3">
            {clips.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setSelectedId(c.id);
                  const v = videoRef.current;
                  if (v) {
                    v.currentTime = c.start;
                    v.play().catch(() => undefined);
                  }
                }}
                className={`w-full text-left bg-panel border rounded-2xl p-4 ${
                  selected?.id === c.id ? "border-accent" : "border-white/10"
                }`}
              >
                <div className="flex justify-between gap-3">
                  <p className="font-bold">{c.title}</p>
                  <span className="shrink-0 bg-gold text-black text-sm font-black rounded-full px-2 py-0.5">
                    {c.scores.total}
                  </span>
                </div>
                <p className="text-xs text-white/60 mt-1">
                  {fmt(c.start)} – {fmt(c.end)} · {c.reason}
                </p>
                <p className="text-xs text-white/60 mt-2">
                  Hook {c.scores.hook.score} ({c.scores.hook.grade}) · Flow {c.scores.flow.score} (
                  {c.scores.flow.grade}) · Value {c.scores.value.score} ({c.scores.value.grade}) · Trend{" "}
                  {c.scores.trend.score} ({c.scores.trend.grade})
                </p>
                <p className="text-xs text-white/50 mt-1">{c.scores.hook.reason}</p>
              </button>
            ))}
          </div>

          {segments.length > 0 && (
            <div className="mt-6">
              <h2 className="font-bold mb-3">Transcript ({segments.length} segments)</h2>
              <div className="bg-panel border border-white/10 rounded-2xl p-4 max-h-72 overflow-y-auto text-sm leading-relaxed">
                {segments.map((s, i) => (
                  <p key={i} className="mb-1">
                    <span className="text-accent font-mono text-xs">[{fmt(s.start)}]</span> {s.text}
                  </p>
                ))}
              </div>
            </div>
          )}

          {jobs.length > 0 && (
            <div className="mt-6">
              <h2 className="font-bold mb-3">Saved jobs (this browser)</h2>
              <div className="space-y-2">
                {jobs.map((j) => (
                  <button
                    key={j.id}
                    onClick={() => {
                      setSegments(j.segments);
                      setClips(j.clips);
                      if (j.clips[0]) setSelectedId(j.clips[0].id);
                      setPhase("ready");
                    }}
                    className="w-full text-left bg-panel border border-white/10 rounded-xl px-4 py-2 text-sm"
                  >
                    {j.fileName} · {j.clips.length} clips ·{" "}
                    {partLabel(
                      j.rangeStartSec != null
                        ? { start: j.rangeStartSec, end: j.rangeEndSec ?? j.durationSec }
                        : null,
                      j.durationSec,
                    )}{" "}
                    · {new Date(j.createdAt).toLocaleString()}
                  </button>
                ))}
              </div>
              <p className="text-xs text-white/40 mt-2">
                Jobs store transcripts and clips in this browser only. Re-upload the video to preview a saved job.
              </p>
            </div>
          )}
        </section>
      </div>

      <footer className="mt-10 text-xs text-white/40 text-center">
        Free video clipping — Groq Whisper transcription, Gemini AI Brain, shot-aware speaker reframe.
        Keys stay server-side in environment variables and are never shown in the page.
      </footer>
    </main>
  );
}
