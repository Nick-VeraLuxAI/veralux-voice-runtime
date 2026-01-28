"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpWavJsonProvider = void 0;
const log_1 = require("../../log");
const postprocess_1 = require("../../audio/postprocess");
const audioProbe_1 = require("../../diagnostics/audioProbe");
const wavGuard_1 = require("../wavGuard");
const mediaDebugEnabled = () => {
    const value = process.env.MEDIA_DEBUG;
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};
class HttpWavJsonProvider {
    constructor() {
        this.id = 'http_wav_json';
        this.supportsPartials = false;
    }
    async transcribe(audio, opts = {}) {
        const url = opts.endpointUrl;
        if (!url || typeof url !== 'string') {
            throw new Error('http_wav_json requires stt.config.url');
        }
        if (audio.encoding !== 'wav') {
            throw new Error('http_wav_json expects WAV input');
        }
        const wavPayload = (0, wavGuard_1.looksLikeWav)(audio.audio)
            ? audio.audio
            : (0, postprocess_1.encodePcm16ToWav)(new Int16Array(audio.audio.buffer, audio.audio.byteOffset, Math.floor(audio.audio.byteLength / 2)), audio.sampleRateHz || 16000);
        (0, wavGuard_1.assertLooksLikeWav)(wavPayload, {
            provider: 'http_wav_json',
            wav_bytes: wavPayload.length,
            ...(opts.logContext ?? {}),
        });
        (0, audioProbe_1.probeWav)('stt.submit.wav', wavPayload, {
            ...(opts.audioMeta ?? {}),
            logContext: opts.logContext ?? opts.audioMeta?.logContext,
            format: 'wav',
            kind: opts.isPartial ? 'partial' : 'final',
        });
        if (mediaDebugEnabled()) {
            log_1.log.info({ event: 'stt_http_wav_json_request', wav_bytes: wavPayload.length }, 'stt http wav json request');
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
            log_1.log.error({ event: 'stt_http_wav_json_error', status: response.status, body_preview: preview }, 'stt http wav json request failed');
            throw new Error(`stt http wav json error ${response.status}: ${preview}`);
        }
        const data = (await response.json());
        const text = typeof data.text === 'string' ? data.text : '';
        return { text, isFinal: true, raw: data };
    }
}
exports.HttpWavJsonProvider = HttpWavJsonProvider;
//# sourceMappingURL=httpWavJson.js.map