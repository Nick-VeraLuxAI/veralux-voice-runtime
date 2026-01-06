import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';

export class DisabledSttProvider implements STTProvider {
  public readonly id = 'disabled';
  public readonly supportsPartials = false;

  public async transcribe(_audio: STTAudioInput, _opts: STTOptions = {}): Promise<STTTranscript> {
    return { text: '', isFinal: true, confidence: 0 };
  }
}