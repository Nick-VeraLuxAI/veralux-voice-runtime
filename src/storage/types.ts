export interface AudioAsset {
  id: string;
  fileName: string;
  localPath: string;
  publicUrl: string;
}

export interface SaveAudioInput {
  data: Buffer;
  extension?: string;
}