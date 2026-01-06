export type STTMode = 'whisper_http' | 'disabled' | 'http_wav_json';

import type { AudioMeta } from '../diagnostics/audioProbe';

export interface STTOptions {
  language?: string;
  prompt?: string;
  hints?: string[];
  isPartial?: boolean;
  endpointUrl?: string;
  logContext?: Record<string, unknown>;
  signal?: AbortSignal;
  audioMeta?: AudioMeta;
}

export interface STTTranscript {
  text: string;
  isFinal: boolean;
  confidence?: number;
  raw?: unknown;
}

export interface STTAudioInput {
  audio: Buffer;
  sampleRateHz: number;
  encoding: 'pcmu' | 'pcm16le' | 'wav';
  channels?: number;
}

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