"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeWav = looksLikeWav;
exports.assertLooksLikeWav = assertLooksLikeWav;
const log_1 = require("../log");
function looksLikeWav(buf) {
    if (buf.length < 12)
        return false;
    return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}
function assertLooksLikeWav(buf, context = {}) {
    if (looksLikeWav(buf))
        return;
    const firstBytesHex = buf.subarray(0, 32).toString('hex');
    log_1.log.error({
        event: 'stt_invalid_wav_payload',
        buf_len: buf.length,
        first_bytes_hex: firstBytesHex,
        ...context,
    }, 'invalid wav payload');
    throw new Error('invalid_wav_payload');
}
//# sourceMappingURL=wavGuard.js.map