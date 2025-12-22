"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkedSTT = void 0;
exports.transcribeChunk = transcribeChunk;
const env_1 = require("../env");
const log_1 = require("../log");
const DEFAULT_MIN_BYTES = 3200;
function extractText(result) {
    if (!result || typeof result !== 'object') {
        return '';
    }
    const record = result;
    if (typeof record.text === 'string') {
        return record.text;
    }
    if (typeof record.transcription === 'string') {
        return record.transcription;
    }
    return '';
}
async function transcribeChunk(request) {
    const response = await fetch(env_1.env.WHISPER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
        },
        body: request.audio,
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`whisper error ${response.status}: ${body}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        const data = (await response.json());
        return {
            text: extractText(data),
            confidence: typeof data.confidence === 'number'
                ? data.confidence
                : undefined,
        };
    }
    const text = await response.text();
    return { text };
}
class ChunkedSTT {
    constructor(options) {
        this.buffer = [];
        this.bufferBytes = 0;
        this.flushQueue = Promise.resolve();
        this.chunkMs = options.chunkMs;
        this.silenceMs = options.silenceMs;
        this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
        this.onTranscript = options.onTranscript;
        this.logContext = options.logContext;
        this.timer = setInterval(() => {
            this.flushIfReady('interval');
        }, this.chunkMs);
        this.timer.unref?.();
    }
    ingest(frame) {
        if (!frame || frame.length === 0) {
            return;
        }
        this.buffer.push(frame);
        this.bufferBytes += frame.length;
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        this.silenceTimer = setTimeout(() => {
            this.flushIfReady('silence');
        }, this.silenceMs);
        this.silenceTimer.unref?.();
    }
    stop() {
        clearInterval(this.timer);
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
    }
    flushIfReady(reason) {
        if (this.bufferBytes === 0) {
            return;
        }
        if (reason === 'interval' && this.bufferBytes < this.minBytes) {
            return;
        }
        const payload = Buffer.concat(this.buffer, this.bufferBytes);
        this.buffer.length = 0;
        this.bufferBytes = 0;
        this.flushQueue = this.flushQueue
            .then(async () => {
            const startedAt = Date.now();
            const result = await transcribeChunk({ audio: payload });
            const durationMs = Date.now() - startedAt;
            const text = result.text.trim();
            log_1.log.info({
                event: 'stt_chunk_transcribed',
                duration_ms: durationMs,
                bytes: payload.length,
                text_length: text.length,
                reason,
                ...(this.logContext ?? {}),
            }, 'stt chunk transcribed');
            if (text === '') {
                return;
            }
            await this.onTranscript(text);
        })
            .catch((error) => {
            log_1.log.error({ err: error, reason, ...(this.logContext ?? {}) }, 'stt chunk transcription failed');
        });
    }
}
exports.ChunkedSTT = ChunkedSTT;
//# sourceMappingURL=chunkedSTT.js.map