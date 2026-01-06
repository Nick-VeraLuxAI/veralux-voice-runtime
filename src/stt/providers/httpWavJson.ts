import { log } from '../../log';
import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';
import { probeWav } from '../../diagnostics/audioProbe';

const mediaDebugEnabled = (): boolean => {
  const value = process.env.MEDIA_DEBUG;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

export class HttpWavJsonProvider implements STTProvider {
  public readonly id = 'http_wav_json';
  public readonly supportsPartials = false;

  public async transcribe(audio: STTAudioInput, opts: STTOptions = {}): Promise<STTTranscript> {
    const url = opts.endpointUrl;
    if (!url || typeof url !== 'string') {
      throw new Error('http_wav_json requires stt.config.url');
    }

    if (audio.encoding !== 'wav') {
      throw new Error('http_wav_json expects WAV input');
    }

    probeWav('stt.submit.wav', audio.audio, {
      ...(opts.audioMeta ?? {}),
      logContext: opts.logContext ?? opts.audioMeta?.logContext,
      format: 'wav',
      kind: opts.isPartial ? 'partial' : 'final',
    });

    if (mediaDebugEnabled()) {
      log.info(
        { event: 'stt_http_wav_json_request', wav_bytes: audio.audio.length },
        'stt http wav json request',
      );
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
      },
      body: new Uint8Array(audio.audio),
      signal: opts.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      log.error(
        { event: 'stt_http_wav_json_error', status: response.status, body_preview: preview },
        'stt http wav json request failed',
      );
      throw new Error(`stt http wav json error ${response.status}: ${preview}`);
    }

    const data = (await response.json()) as { text?: string };
    const text = typeof data.text === 'string' ? data.text : '';
    return { text, isFinal: true, raw: data };
  }
}