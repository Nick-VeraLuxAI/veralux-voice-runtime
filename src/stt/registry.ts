import type { STTProvider as ChunkedSttProvider } from './chunkedSTT';
import type { STTProvider as CoreSttProvider } from './provider';
import type { STTMode } from './types';

import { DisabledSttProvider } from './providers/disabled';
import { HttpWavJsonProvider } from './providers/httpWavJson';
import { WhisperHttpProvider } from './providers/whisperHttp';
import { env } from '../env';
import { log } from '../log';

type ChunkedProviderId = ChunkedSttProvider['id'];

/**
 * Adapter: wraps "core" STT providers to match the exact interface ChunkedSTT expects.
 * ChunkedSTT expects transcribe() -> Promise<{ text: string }>.
 */
function wrapProvider(id: ChunkedProviderId, provider: CoreSttProvider): ChunkedSttProvider {
  return {
    id,
    async transcribe(audio, opts) {
      const result = await provider.transcribe(audio, opts);
      return { text: result.text };
    },
  };
}

/**
 * Registry: maps tenant-selected STT mode strings to concrete provider implementations.
 * Keep this as the single mapping source-of-truth so STT remains pluggable.
 */
const providers: Record<STTMode, ChunkedSttProvider> = {
  // Disabled: still uses the "pcm" branch in ChunkedSTT (encoding pcm16le)
  disabled: wrapProvider('http_pcm16', new DisabledSttProvider()),

  // Default whisper provider (pcm16le HTTP)
  whisper_http: wrapProvider('http_pcm16', new WhisperHttpProvider()),

  // WAV-json provider (wav encoding HTTP)
  http_wav_json: wrapProvider('http_wav_json', new HttpWavJsonProvider()),
};

/**
 * Get provider for a given STT mode.
 * Includes a safe fallback so a bad/missing tenant mode cannot crash calls.
 */
export function getProvider(mode: STTMode): ChunkedSttProvider {
  let selectedMode = mode;
  if (mode === 'http_wav_json' && !env.ALLOW_HTTP_WAV_JSON) {
    selectedMode = 'whisper_http';
    log.warn(
      {
        event: 'stt_provider_mode_blocked',
        requested_mode: mode,
        selected_mode: selectedMode,
        reason: 'ALLOW_HTTP_WAV_JSON_disabled',
      },
      'stt provider mode blocked',
    );
  }

  const provider = providers[selectedMode] ?? providers.whisper_http;
  log.info(
    {
      event: 'stt_provider_selected',
      stt_mode: selectedMode,
      provider_id: provider.id,
    },
    'stt provider selected',
  );
  return provider;
}
