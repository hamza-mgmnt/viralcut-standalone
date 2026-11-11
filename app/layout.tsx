import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ViralCut Clone — Free AI Video Clipping",
  description:
    "Turn long videos into viral clips: Groq Whisper transcription, Gemini AI Brain, shot-aware active-speaker 9:16 reframe and viral captions. Free, no payment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink text-white min-h-screen">{children}</body>
    </html>
  );
}
