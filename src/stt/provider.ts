import type { STTAudioInput, STTMode, STTOptions, STTTranscript } from './types';

export interface STTProvider {
  id: STTMode;
  supportsPartials: boolean;
  transcribe(audio: STTAudioInput, opts?: STTOptions): Promise<STTTranscript>;
}