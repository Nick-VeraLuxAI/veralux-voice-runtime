"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamIngest = void 0;
const log_1 = require("../log");
class StreamIngest {
    constructor(config) {
        this.config = config;
    }
    ingest(frame) {
        const payload = Buffer.isBuffer(frame) ? frame : frame.data;
        const timestampMs = Buffer.isBuffer(frame) ? undefined : frame.timestampMs;
        log_1.log.debug({
            timestampMs,
            bytes: payload.length,
            sampleRate: this.config.sampleRate,
        }, 'media frame ingested');
    }
}
exports.StreamIngest = StreamIngest;
//# sourceMappingURL=streamIngest.js.map