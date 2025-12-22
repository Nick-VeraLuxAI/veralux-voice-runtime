export interface TTSRequest {
  text: string;
  voice?: string;
}

export interface TTSResult {
  audio: Buffer;
  contentType: string;
}
