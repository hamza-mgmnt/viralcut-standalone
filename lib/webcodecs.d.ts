// Minimal WebCodecs AUDIO declarations.
//
// TypeScript 5.5's DOM lib ships the WebCodecs video side (VideoDecoder)
// but not the audio side, so the exact surface lib/range-decode.ts uses
// is declared here from the WebCodecs spec. Keep this file minimal: only
// the members the code touches. If a future TypeScript upgrade adds these
// to lib.dom, delete this file (duplicate-identifier errors will say so).

type AudioSampleFormat =
  | "u8"
  | "s16"
  | "s32"
  | "f32"
  | "u8-planar"
  | "s16-planar"
  | "s32-planar"
  | "f32-planar";

interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: BufferSource;
}

interface AudioDecoderSupport {
  supported: boolean;
  config: AudioDecoderConfig;
}

interface AudioDataCopyToOptions {
  planeIndex: number;
  frameOffset?: number;
  frameCount?: number;
  format?: AudioSampleFormat;
}

declare class AudioData {
  readonly format: AudioSampleFormat | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  readonly timestamp: number;
  copyTo(destination: BufferSource, options: AudioDataCopyToOptions): void;
  clone(): AudioData;
  close(): void;
}

type EncodedAudioChunkType = "key" | "delta";

interface EncodedAudioChunkInit {
  type: EncodedAudioChunkType;
  timestamp: number;
  duration?: number;
  data: BufferSource;
}

declare class EncodedAudioChunk {
  constructor(init: EncodedAudioChunkInit);
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  copyTo(destination: BufferSource): void;
}

interface AudioDecoderInit {
  output: (output: AudioData) => void;
  error: (error: Error) => void;
}

declare class AudioDecoder {
  constructor(init: AudioDecoderInit);
  static isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport>;
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  readonly state: "unconfigured" | "configured" | "closed";
  readonly decodeQueueSize: number;
}
