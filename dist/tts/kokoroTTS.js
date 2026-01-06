"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.synthesizeSpeech = synthesizeSpeech;
const env_1 = require("../env");
const log_1 = require("../log");
async function synthesizeSpeech(request) {
    const kokoroUrl = request.kokoroUrl ?? env_1.env.KOKORO_URL;
    const sampleRate = request.sampleRate ?? env_1.env.TTS_SAMPLE_RATE;
    const format = request.format ?? 'wav';
    log_1.log.info({ event: 'tts_request', sample_rate: sampleRate, voice: request.voice, format }, 'tts request');
    const response = await fetch(kokoroUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: request.text,
            voice: request.voice,
            format,
            sampleRate,
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        log_1.log.error({ status: response.status, body }, 'kokoro tts error');
        throw new Error(`kokoro tts error ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
        audio: Buffer.from(arrayBuffer),
        contentType: response.headers.get('content-type') ?? 'audio/wav',
    };
}
//# sourceMappingURL=kokoroTTS.js.map