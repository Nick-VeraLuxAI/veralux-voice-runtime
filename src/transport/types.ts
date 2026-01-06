export type TransportMode = 'pstn' | 'webrtc_hd';

export type PlaybackInput =
  | { kind: 'url'; url: string }
  | { kind: 'buffer'; audio: Buffer; contentType?: string };

export interface AudioIngest {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  onFrame(cb: (frame: Buffer) => void): void;
}

export interface AudioPlayback {
  play(input: PlaybackInput): Promise<void>;
  stop(): Promise<void>;
  onPlaybackEnd(cb: () => void): void;
}

export interface TransportSession {
  id: string;
  mode: TransportMode;
  ingest: AudioIngest;
  playback: AudioPlayback;
  audioInput: { codec: 'pcmu' | 'pcm16le'; sampleRateHz: number };
  start(): Promise<void> | void;
  stop(reason?: string): Promise<void> | void;
  pushFrame?(frame: Buffer): void;
  notifyPlaybackEnded?(): void;
}