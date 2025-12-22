export type AudioFormat = 'pcm16le' | 'mulaw';

export interface MediaStreamConfig {
  sampleRate: number;
  channels: number;
  format: AudioFormat;
}

export type MediaFrame = Buffer;

export interface MediaFrameEnvelope {
  data: Buffer;
  timestampMs?: number;
  sequence?: number;
  format?: AudioFormat;
}
