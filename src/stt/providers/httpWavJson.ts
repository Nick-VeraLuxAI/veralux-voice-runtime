import { log } from '../../log';
import { encodePcm16ToWav } from '../../audio/postprocess';
import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';
import { probeWav } from '../../diagnostics/audioProbe';
import { assertLooksLikeWav, looksLikeWav } from '../wavGuard';

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

    const wavPayload = looksLikeWav(audio.audio)
      ? audio.audio
      : encodePcm16ToWav(
          new Int16Array(audio.audio.buffer, audio.audio.byteOffset, Math.floor(audio.audio.byteLength / 2)),
          audio.sampleRateHz || 16000,
        );

    assertLooksLikeWav(wavPayload, {
      provider: 'http_wav_json',
      wav_bytes: wavPayload.length,
      ...(opts.logContext ?? {}),
    });

    probeWav('stt.submit.wav', wavPayload, {
      ...(opts.audioMeta ?? {}),
      logContext: opts.logContext ?? opts.audioMeta?.logContext,
      format: 'wav',
      kind: opts.isPartial ? 'partial' : 'final',
    });

    if (mediaDebugEnabled()) {
      log.info(
        { event: 'stt_http_wav_json_request', wav_bytes: wavPayload.length },
        'stt http wav json request',
      );
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
      },
      body: new Uint8Array(wavPayload),
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
