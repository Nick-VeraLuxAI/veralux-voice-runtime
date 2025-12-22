export interface STTRequest {
  audio: Buffer;
  sampleRate?: number;
}

export interface STTResult {
  text: string;
  confidence?: number;
}

export interface ChunkedSTTConfig {
  chunkMs: number;
  silenceMs: number;
  minBytes?: number;
}
