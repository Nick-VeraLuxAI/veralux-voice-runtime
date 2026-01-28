export type AudioFormat = 'pcm16le' | 'mulaw';

export interface MediaStreamConfig {
  sampleRate: number;
  channels: number;
  format: AudioFormat;
}

export type MediaFrame = Buffer;

export type Pcm16Frame = {
  pcm16: Int16Array;
  sampleRateHz: number;
  channels: 1;
};

export interface MediaFrameEnvelope {
  data: Buffer;
  timestampMs?: number;
  sequence?: number;
  format?: AudioFormat;
}
