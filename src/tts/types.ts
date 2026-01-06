export interface TTSRequest {
  text: string;
  voice?: string;
  format?: string;
  sampleRate?: number;
  kokoroUrl?: string;
}

export interface TTSResult {
  audio: Buffer;
  contentType: string;
}