"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
const disabled_1 = require("./providers/disabled");
const httpWavJson_1 = require("./providers/httpWavJson");
const whisperHttp_1 = require("./providers/whisperHttp");
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
    return providers[mode] ?? providers.whisper_http;
}
//# sourceMappingURL=registry.js.map