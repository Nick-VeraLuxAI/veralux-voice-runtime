"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STT_TRACE_ENABLED = void 0;
exports.shouldTrace = shouldTrace;
exports.sha1_10 = sha1_10;
exports.traceInfo = traceInfo;
exports.traceWarn = traceWarn;
// src/stt/debugSttTrace.ts
const crypto_1 = __importDefault(require("crypto"));
const log_1 = require("../log");
function parseBool(v) {
    if (typeof v !== 'string')
        return false;
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}
exports.STT_TRACE_ENABLED = (() => {
    const v = process.env.STT_TRACE;
    return v == null ? false : parseBool(v);
})();
const DEFAULT_LIMIT = 12;
const LIMIT = (() => {
    const n = Number.parseInt(process.env.STT_TRACE_LIMIT ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
})();
// per callId counter
const counters = new Map();
function shouldTrace(callId) {
    if (!exports.STT_TRACE_ENABLED)
        return false;
    if (LIMIT === 0)
        return true;
    const n = (counters.get(callId) ?? 0) + 1;
    counters.set(callId, n);
    return n <= LIMIT;
}
function sha1_10(buf) {
    return crypto_1.default.createHash('sha1').update(buf).digest('hex').slice(0, 10);
}
function traceInfo(callId, obj, msg) {
    if (!shouldTrace(callId))
        return;
    log_1.log.info({ ...obj, call_id: callId }, msg);
}
function traceWarn(callId, obj, msg) {
    if (!shouldTrace(callId))
        return;
    log_1.log.warn({ ...obj, call_id: callId }, msg);
}
//# sourceMappingURL=debugSttTrace.js.map