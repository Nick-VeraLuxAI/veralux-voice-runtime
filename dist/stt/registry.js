"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
const disabled_1 = require("./providers/disabled");
const httpWavJson_1 = require("./providers/httpWavJson");
const whisperHttp_1 = require("./providers/whisperHttp");
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
 * Keep this as the single mapping source-of-truth so STT remains pluggable.
 */
const providers = {
    // Disabled: still uses the "pcm" branch in ChunkedSTT (encoding pcm16le)
    disabled: wrapProvider('http_pcm16', new disabled_1.DisabledSttProvider()),
    // Default whisper provider (pcm16le HTTP)
    whisper_http: wrapProvider('http_pcm16', new whisperHttp_1.WhisperHttpProvider()),
    // WAV-json provider (wav encoding HTTP)
    http_wav_json: wrapProvider('http_wav_json', new httpWavJson_1.HttpWavJsonProvider()),
};
/**
 * Get provider for a given STT mode.
 * Includes a safe fallback so a bad/missing tenant mode cannot crash calls.
 */
function getProvider(mode) {
    let selectedMode = mode;
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