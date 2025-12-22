"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.synthesizeSpeech = synthesizeSpeech;
const env_1 = require("../env");
const log_1 = require("../log");
async function synthesizeSpeech(request) {
    const response = await fetch(env_1.env.KOKORO_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: request.text,
            voice: request.voice,
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