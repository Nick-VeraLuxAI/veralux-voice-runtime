"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
const disabled_1 = require("./providers/disabled");
const whisperHttp_1 = require("./providers/whisperHttp");
// If you still have this provider, you can leave the import out for now.
// import { HttpWavJsonProvider } from './providers/httpWavJson';
const env_1 = require("../env");
const log_1 = require("../log");
/**
 * Adapter: wraps "core" STT providers to match the exact interface ChunkedSTT expects.
 * ChunkedSTT expects transcribe() -> Promise<{ text: string }>.
 */
function wrapProvider(id, provider) {
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
 *
 * IMPORTANT:
 * - ChunkedSTT is currently PCM16LE-only.
 * - We keep 'http_wav_json' as a *mode* for backwards compatibility, but we route it
 *   to the PCM path unless you explicitly re-enable a true WAV-json provider end-to-end.
 */
const providers = {
    disabled: wrapProvider('http_pcm16', new disabled_1.DisabledSttProvider()),
    whisper_http: wrapProvider('http_pcm16', new whisperHttp_1.WhisperHttpProvider()),
    // Back-compat mode: still uses WhisperHttpProvider (PCM16LE in, WAV out if provider wraps)
    http_wav_json: wrapProvider('http_pcm16', new whisperHttp_1.WhisperHttpProvider()),
    // If/when you truly want this mode again, only do it after ChunkedSTT can emit real WAV bytes:
    // http_wav_json: wrapProvider('http_wav_json', new HttpWavJsonProvider()),
};
/**
 * Get provider for a given STT mode.
 * Includes a safe fallback so a bad/missing tenant mode cannot crash calls.
 */
function getProvider(mode) {
    let selectedMode = mode;
    // If this flag exists, keep it meaningful.
    if (mode === 'http_wav_json' && !env_1.env.ALLOW_HTTP_WAV_JSON) {
        selectedMode = 'whisper_http';
        log_1.log.warn({
            event: 'stt_provider_mode_blocked',
            requested_mode: mode,
            selected_mode: selectedMode,
            reason: 'ALLOW_HTTP_WAV_JSON_disabled',
        }, 'stt provider mode blocked');
    }
    const provider = providers[selectedMode] ?? providers.whisper_http;
    log_1.log.info({
        event: 'stt_provider_selected',
        stt_mode: selectedMode,
        provider_id: provider.id,
    }, 'stt provider selected');
    return provider;
}
//# sourceMappingURL=registry.js.map