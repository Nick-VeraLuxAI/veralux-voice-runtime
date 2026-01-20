"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaIngest = exports.MediaIngestHealthMonitor = void 0;
exports.normalizeTelnyxTrack = normalizeTelnyxTrack;
// src/media/mediaIngest.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const codecDecode_1 = require("../audio/codecDecode");
const prepareAmrWbPayload_1 = require("../audio/prepareAmrWbPayload");
const debugAudioTap_1 = require("../audio/debugAudioTap");
const audioProbe_1 = require("../diagnostics/audioProbe");
const log_1 = require("../log");
const DEFAULT_HEALTH_WINDOW_MS = 1000;
const DEFAULT_HEALTH_RMS_FLOOR = 0.001;
const DEFAULT_HEALTH_MIN_FRAMES = 10;
const DEFAULT_HEALTH_MIN_EMIT_CHUNKS = 10;
const DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT = 10;
const DEFAULT_HEALTH_DECODE_FAILURE_LIMIT = 5;
const DEFAULT_EMIT_MS = 100;
const MIN_EMIT_MS = 80;
const MAX_EMIT_MS = 200;
const DEFAULT_DEBUG_DUMP_COUNT = 20;
const AMRWB_EMIT_DEBUG_MAX = 30;
const AMRWB_EMIT_DEBUG_INTERVAL_MS = 1000;
const AMRWB_NEAR_ZERO_THRESHOLD = 1;
const TELNYX_CAPTURE_WINDOW_MS = 3000;
const TELNYX_CAPTURE_MAX_FRAMES = 150;
const TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT = 10;
const TELNYX_CAPTURE_TINY_PAYLOAD_LEN = 50;
let captureConsumed = false;
let captureActiveCallId = null;
const SENSITIVE_KEY_REGEX = /(token|authorization|auth|signature|secret|api_key)/i;
const AMRWB_FILE_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');
/* ---------------------------------- env ---------------------------------- */
function parseBoolEnv(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
function mediaSchemaDebugEnabled() {
    return parseBoolEnv(process.env.TELNYX_DEBUG_MEDIA_SCHEMA);
}
function telnyxTapRawEnabled() {
    return parseBoolEnv(process.env.TELNYX_DEBUG_TAP_RAW);
}
function telnyxCaptureOnceEnabled() {
    return parseBoolEnv(process.env.TELNYX_CAPTURE_ONCE);
}
function telnyxCaptureCallId() {
    const raw = process.env.TELNYX_CAPTURE_CALL_ID;
    return raw && raw.trim() !== '' ? raw.trim() : null;
}
function telnyxDebugDir() {
    return process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== ''
        ? process.env.STT_DEBUG_DIR.trim()
        : '/tmp/veralux-stt-debug';
}
function sttDebugDumpFramesEnabled() {
    return parseBoolEnv(process.env.STT_DEBUG_DUMP_FRAMES);
}
function sttDebugDumpCount() {
    const raw = process.env.STT_DEBUG_DUMP_COUNT;
    if (!raw)
        return DEFAULT_DEBUG_DUMP_COUNT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_DEBUG_DUMP_COUNT;
    return Math.floor(parsed);
}
function sttDebugDumpDir() {
    const raw = process.env.STT_DEBUG_DUMP_DIR;
    return raw && raw.trim() !== '' ? raw.trim() : '/tmp/veralux-stt-debug';
}
function amrwbTruthCaptureEnabled() {
    return parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB);
}
function resolveEmitMs() {
    const raw = process.env.STT_EMIT_MS ?? process.env.STT_MIN_EMIT_MS;
    if (!raw)
        return DEFAULT_EMIT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_EMIT_MS;
    return Math.max(MIN_EMIT_MS, Math.min(MAX_EMIT_MS, Math.round(parsed)));
}
function emitChunkDebugEnabled() {
    return telnyxTapRawEnabled() || parseBoolEnv(process.env.AUDIO_TAP) || (0, audioProbe_1.diagnosticsEnabled)();
}
function amrwbEmitDebugEnabled() {
    return parseBoolEnv(process.env.AMRWB_DECODE_DEBUG);
}
/* ------------------------------- sanitizers ------------------------------- */
function redactInline(value) {
    let redacted = value;
    const token = process.env.MEDIA_STREAM_TOKEN;
    if (token && redacted.includes(token))
        redacted = redacted.split(token).join('[redacted]');
    redacted = redacted.replace(/token=([^&\s]+)/gi, 'token=[redacted]');
    return redacted;
}
function sanitizeForCapture(value, pathParts = []) {
    if (typeof value === 'string') {
        const key = pathParts[pathParts.length - 1] ?? '';
        if (SENSITIVE_KEY_REGEX.test(key))
            return '[redacted]';
        if (key === 'payload') {
            const trimmed = value.trim();
            return `[payload len=${trimmed.length}]`;
        }
        return redactInline(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null)
        return value;
    if (Array.isArray(value))
        return value.map((item, index) => sanitizeForCapture(item, pathParts.concat(String(index))));
    if (value && typeof value === 'object') {
        const obj = value;
        const sanitized = {};
        for (const [key, val] of Object.entries(obj))
            sanitized[key] = sanitizeForCapture(val, pathParts.concat(key));
        return sanitized;
    }
    return value;
}
function getHexPrefix(buf, len = 16) {
    return buf.subarray(0, len).toString('hex');
}
function looksLikeAmrWbMagic(buf) {
    const magic = Buffer.from('#!AMR-WB\n', 'ascii');
    return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}
/** Telnyx PSTN inbound AMR-WB speech payloads observed as 33 bytes. */
function isLikelyAmrwbSpeechPayload(payload) {
    return payload.length === 33;
}
function looksLikeTelnyxNoCmrToc33(buf) {
    if (buf.length !== 33)
        return false;
    const toc = buf[0] ?? 0;
    const ft = (toc >> 3) & 0x0f;
    const qSet = (toc & 0x04) !== 0;
    // valid speech FT are 0..9 (10-13 invalid, 14 lost, 15 no-data)
    if (!qSet)
        return false;
    if (ft >= 10)
        return false;
    // In your observed case we expect FT=2 most of the time => toc == 0x14
    return true;
}
function looksLikeWavRiff(buf) {
    if (buf.length < 12)
        return false;
    return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}
function safeFileToken(value) {
    return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
/* --------------------------------- buckets -------------------------------- */
function bucketLen(value) {
    if (value < 10)
        return '<10';
    if (value < 50)
        return '10-49';
    if (value < 100)
        return '50-99';
    if (value < 200)
        return '100-199';
    if (value < 500)
        return '200-499';
    if (value < 1000)
        return '500-999';
    if (value < 2000)
        return '1000-1999';
    return '2000+';
}
function incrementBucket(target, value) {
    const key = bucketLen(value);
    target[key] = (target[key] ?? 0) + 1;
}
/* ----------------------------- payload decoding ---------------------------- */
function looksLikeBase64(payload) {
    const trimmed = payload.trim().replace(/=+$/, '');
    if (trimmed.length < 8)
        return false;
    return /^[A-Za-z0-9+/_-]+$/.test(trimmed);
}
function decodeTelnyxPayloadWithInfo(payload) {
    let trimmed = payload.trim();
    const useBase64Url = trimmed.includes('-') || trimmed.includes('_');
    const encoding = useBase64Url ? 'base64url' : 'base64';
    const mod = trimmed.length % 4;
    if (mod !== 0)
        trimmed += '='.repeat(4 - mod);
    return { buffer: Buffer.from(trimmed, encoding), encoding, trimmed };
}
/* --------------------------- AMR-WB capture parse -------------------------- */
const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;
const AMRWB_SPEECH_LOST_FT = 14;
const AMRWB_NO_DATA_FT = 15;
function amrWbFrameSize(ft) {
    if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length)
        return AMRWB_FRAME_SIZES[ft] ?? 0;
    if (ft === 9)
        return AMRWB_SID_FRAME_BYTES;
    return 0;
}
function debugParseAmrWbOctetAligned(payload, startOffset) {
    // payload[0] is CMR when startOffset === 1 (octet-aligned mode).
    const cmr = startOffset === 1 ? (payload[0] >> 4) & 0x0f : null;
    if (payload.length === 0)
        return { offset: startOffset, ok: false, frames: 0, reason: 'empty', cmr };
    if (startOffset >= payload.length) {
        return { offset: startOffset, ok: false, frames: 0, reason: 'start_offset_out_of_range', cmr };
    }
    let offset = startOffset;
    const tocEntries = [];
    let follow = true;
    while (follow && offset < payload.length) {
        const toc = payload[offset++];
        follow = (toc & 0x80) !== 0;
        const ft = (toc >> 3) & 0x0f;
        if (ft >= 10 && ft <= 13) {
            return { offset: startOffset, ok: false, frames: 0, reason: `invalid_ft_${ft}`, invalidFt: ft, cmr };
        }
        tocEntries.push(ft);
    }
    if (tocEntries.length === 0) {
        return { offset: startOffset, ok: false, frames: 0, reason: 'missing_toc', cmr };
    }
    let frames = 0;
    for (const ft of tocEntries) {
        if (ft === AMRWB_NO_DATA_FT || ft === AMRWB_SPEECH_LOST_FT) {
            continue;
        }
        const size = amrWbFrameSize(ft);
        if (size === AMRWB_SID_FRAME_BYTES) {
            if (offset + size > payload.length) {
                return { offset: startOffset, ok: false, frames, reason: `sid_overflow_ft_${ft}`, cmr };
            }
            offset += size;
            continue;
        }
        if (size <= 0)
            return { offset: startOffset, ok: false, frames, reason: `invalid_ft_${ft}`, invalidFt: ft, cmr };
        if (offset + size > payload.length) {
            return { offset: startOffset, ok: false, frames, reason: `frame_overflow_ft_${ft}`, cmr };
        }
        frames += 1;
        offset += size;
    }
    return { offset: startOffset, ok: true, frames, cmr };
}
function debugParseAmrWbPayload(payload) {
    if (payload.length === 0)
        return { ok: false, mode: 'empty', frames: 0, reason: 'empty' };
    if (AMRWB_FRAME_SIZES.includes(payload.length))
        return { ok: true, mode: 'single', frames: 1 };
    if (payload.length === AMRWB_SID_FRAME_BYTES)
        return { ok: true, mode: 'sid', frames: 0 };
    if (payload.length < 2)
        return { ok: false, mode: 'too_short', frames: 0, reason: 'payload_too_short' };
    const withCmr = debugParseAmrWbOctetAligned(payload, 1);
    if (withCmr.ok)
        return { ok: true, mode: 'octet_cmr', frames: withCmr.frames };
    const withoutCmr = debugParseAmrWbOctetAligned(payload, 0);
    if (withoutCmr.ok)
        return { ok: true, mode: 'octet_no_cmr', frames: withoutCmr.frames };
    return {
        ok: false,
        mode: 'octet_failed',
        frames: 0,
        reason: `${withCmr.reason ?? 'unknown'}|${withoutCmr.reason ?? 'unknown'}`,
        attempts: [withCmr, withoutCmr],
    };
}
/* ---------------------------- candidate selection -------------------------- */
function pickBestPayloadCandidate(candidates, codec) {
    const scored = candidates
        .map((c) => {
        const raw = c.value;
        const trimmed = raw.trim();
        const base64ish = looksLikeBase64(trimmed);
        let decodedLen = 0;
        let ok = false;
        if (base64ish) {
            try {
                const decoded = decodeTelnyxPayloadWithInfo(trimmed);
                decodedLen = decoded.buffer.length;
                if (codec === 'AMR-WB') {
                    ok = decodedLen >= 20;
                }
                else {
                    ok = decodedLen >= 10;
                }
            }
            catch {
                ok = false;
            }
        }
        return { c, base64ish, ok, decodedLen, strLen: trimmed.length };
    })
        .filter((x) => x.base64ish)
        .sort((a, b) => {
        if (a.ok !== b.ok)
            return a.ok ? -1 : 1;
        if (b.decodedLen !== a.decodedLen)
            return b.decodedLen - a.decodedLen;
        return b.strLen - a.strLen;
    });
    return scored[0]?.c ?? null;
}
/* --------------------------------- codec ---------------------------------- */
function normalizeCodec(value) {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!normalized)
        return 'AMR-WB';
    if (normalized === 'AMRWB' || normalized === 'AMR_WB')
        return 'AMR-WB';
    return normalized;
}
function normalizeTelnyxTrack(track) {
    const normalized = typeof track === 'string' ? track.trim().toLowerCase() : '';
    if (normalized === 'inbound_track')
        return 'inbound';
    if (normalized === 'outbound_track')
        return 'outbound';
    return normalized;
}
/* --------------------------------- stats ---------------------------------- */
function computePcmStats(samples) {
    if (samples.length === 0)
        return { rms: 0, peak: 0 };
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const s = (samples[i] ?? 0) / 32768;
        const a = Math.abs(s);
        if (a > peak)
            peak = a;
        sumSquares += s * s;
    }
    return { rms: Math.sqrt(sumSquares / samples.length), peak };
}
/* ------------------------------ capture state ------------------------------ */
function shouldStartCapture(callControlId) {
    if (captureConsumed)
        return false;
    const target = telnyxCaptureCallId();
    if (target)
        return target === callControlId;
    if (!telnyxCaptureOnceEnabled())
        return false;
    if (!captureActiveCallId)
        captureActiveCallId = callControlId;
    return captureActiveCallId === callControlId;
}
function initCaptureState(callControlId) {
    if (!shouldStartCapture(callControlId))
        return null;
    const dir = telnyxDebugDir();
    const captureId = `${callControlId}_${Date.now()}`;
    const ndjsonPath = path_1.default.join(dir, `telnyx_media_capture_${captureId}.ndjson`);
    void fs_1.default.promises.mkdir(dir, { recursive: true });
    return {
        callControlId,
        captureId,
        ndjsonPath,
        dir,
        firstEventMs: Date.now(),
        frameCount: 0,
        tinyPayloadFrames: 0,
        notAudioFrames: 0,
        eventCounts: {},
        payloadLenBuckets: {},
        decodedLenBuckets: {},
        payloadSources: new Set(),
        payloadSourceCounts: {},
        trackCombos: new Set(),
        payloadBase64Frames: 0,
        payloadNotBase64Frames: 0,
        mediaExamples: [],
    };
}
async function appendCaptureRecord(capture, record) {
    try {
        await fs_1.default.promises.appendFile(capture.ndjsonPath, `${JSON.stringify(record)}\n`);
    }
    catch (error) {
        log_1.log.warn({ event: 'media_capture_write_failed', call_control_id: capture.callControlId, err: error }, 'media capture write failed');
    }
}
async function dumpCaptureFrame(capture, callControlId, seq, payloadBase64) {
    const base = path_1.default.join(capture.dir, `capture_${callControlId}_${seq}_${Date.now()}`);
    try {
        const decoded = decodeTelnyxPayloadWithInfo(payloadBase64);
        const rawBuf = decoded.buffer;
        const rawPrefixHex = rawBuf.subarray(0, 32).toString('hex');
        await fs_1.default.promises.writeFile(`${base}.raw.bin`, rawBuf);
        await fs_1.default.promises.writeFile(`${base}.raw_prefix.hex`, rawPrefixHex);
        await fs_1.default.promises.writeFile(`${base}.raw_len.txt`, String(rawBuf.length));
        await fs_1.default.promises.writeFile(`${base}.raw_encoding.txt`, decoded.encoding);
    }
    catch (error) {
        log_1.log.warn({ event: 'media_capture_dump_failed', call_control_id: callControlId, err: error }, 'media capture dump failed');
    }
}
async function dumpCaptureDecodedPcm(capture, callControlId, seq, decodedBuf) {
    const base = path_1.default.join(capture.dir, `capture_${callControlId}_${seq}_${Date.now()}`);
    try {
        const decodedPrefixHex = decodedBuf.subarray(0, 32).toString('hex');
        await fs_1.default.promises.writeFile(`${base}.decoded.pcm`, decodedBuf);
        await fs_1.default.promises.writeFile(`${base}.decoded_prefix.hex`, decodedPrefixHex);
        await fs_1.default.promises.writeFile(`${base}.decoded_len.txt`, String(decodedBuf.length));
    }
    catch (error) {
        log_1.log.warn({ event: 'media_capture_decoded_dump_failed', call_control_id: callControlId, err: error }, 'media capture decoded dump failed');
    }
}
async function dumpTelnyxRawPayload(callControlId, payload) {
    if (!telnyxTapRawEnabled())
        return;
    const dir = telnyxDebugDir();
    const base = path_1.default.join(dir, `telnyx_raw_${callControlId}_${Date.now()}`);
    try {
        await fs_1.default.promises.mkdir(dir, { recursive: true });
        const decoded = decodeTelnyxPayloadWithInfo(payload);
        const rawBuf = decoded.buffer;
        const rawPrefixHex = rawBuf.subarray(0, 32).toString('hex');
        await fs_1.default.promises.writeFile(`${base}.raw.bin`, rawBuf);
        await fs_1.default.promises.writeFile(`${base}.raw_prefix.hex`, rawPrefixHex);
        await fs_1.default.promises.writeFile(`${base}.raw_len.txt`, String(rawBuf.length));
        await fs_1.default.promises.writeFile(`${base}.raw_encoding.txt`, decoded.encoding);
        await fs_1.default.promises.writeFile(`${base}.txt`, decoded.trimmed);
    }
    catch (error) {
        log_1.log.warn({ event: 'telnyx_raw_dump_failed', call_control_id: callControlId, err: error }, 'telnyx raw dump failed');
    }
}
async function dumpTelnyxDecodedPcm(callControlId, seq, decodedBuf) {
    if (!telnyxTapRawEnabled())
        return;
    const dir = telnyxDebugDir();
    const base = path_1.default.join(dir, `telnyx_decoded_${callControlId}_${seq}_${Date.now()}`);
    try {
        await fs_1.default.promises.mkdir(dir, { recursive: true });
        const decodedPrefixHex = decodedBuf.subarray(0, 32).toString('hex');
        await fs_1.default.promises.writeFile(`${base}.decoded.pcm`, decodedBuf);
        await fs_1.default.promises.writeFile(`${base}.decoded_prefix.hex`, decodedPrefixHex);
        await fs_1.default.promises.writeFile(`${base}.decoded_len.txt`, String(decodedBuf.length));
    }
    catch (error) {
        log_1.log.warn({ event: 'telnyx_decoded_dump_failed', call_control_id: callControlId, err: error }, 'telnyx decoded dump failed');
    }
}
function summarizeCapture(capture, reason) {
    const expectedTrack = normalizeTelnyxTrack(process.env.TELNYX_STREAM_TRACK);
    const trackCombos = Array.from(capture.trackCombos);
    const payloadSources = Array.from(capture.payloadSources);
    const likelyCauses = [];
    if (expectedTrack && trackCombos.some((combo) => !combo.includes(`media:${expectedTrack}`))) {
        likelyCauses.push('track_mismatch');
    }
    if (capture.payloadNotBase64Frames > 0)
        likelyCauses.push('payload_not_base64');
    if (capture.notAudioFrames > 0)
        likelyCauses.push('decoded_len_too_small');
    if (capture.tinyPayloadFrames >= TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT)
        likelyCauses.push('payload_len_too_small');
    log_1.log.info({
        event: 'media_capture_summary',
        call_control_id: capture.callControlId,
        reason,
        event_counts: capture.eventCounts,
        payload_len_hist: capture.payloadLenBuckets,
        decoded_len_hist: capture.decodedLenBuckets,
        payload_sources: payloadSources,
        payload_source_counts: capture.payloadSourceCounts,
        track_combinations: trackCombos,
        tiny_payload_frames: capture.tinyPayloadFrames,
        not_audio_frames: capture.notAudioFrames,
        payload_base64_frames: capture.payloadBase64Frames,
        payload_not_base64_frames: capture.payloadNotBase64Frames,
        media_examples: capture.mediaExamples,
        capture_ndjson: capture.ndjsonPath,
        likely_causes: likelyCauses,
    }, 'media capture summary');
}
function finalizeCapture(capture, reason) {
    if (capture.stopped)
        return;
    capture.stopped = true;
    captureConsumed = true;
    if (captureActiveCallId === capture.callControlId)
        captureActiveCallId = null;
    summarizeCapture(capture, reason);
}
/* ------------------------------ health monitor ----------------------------- */
class MediaIngestHealthMonitor {
    constructor() {
        this.totalFrames = 0;
        this.decodedFrames = 0;
        this.silentFrames = 0;
        this.emittedChunks = 0;
        this.rollingRmsWindow = [];
        this.rollingRmsSum = 0;
        this.rollingRms = 0;
        this.tinyPayloadFrames = 0;
        this.decodeFailures = 0;
        this.lastRms = 0;
        this.lastPeak = 0;
        this.disabled = false;
        this.evaluated = false;
    }
    start(now) {
        if (this.disabled)
            return;
        this.startedAtMs = now;
        this.endAtMs = now + DEFAULT_HEALTH_WINDOW_MS;
        this.totalFrames = 0;
        this.decodedFrames = 0;
        this.silentFrames = 0;
        this.emittedChunks = 0;
        this.rollingRmsWindow = [];
        this.rollingRmsSum = 0;
        this.rollingRms = 0;
        this.tinyPayloadFrames = 0;
        this.decodeFailures = 0;
        this.lastRms = 0;
        this.lastPeak = 0;
        this.evaluated = false;
    }
    disable() {
        this.disabled = true;
    }
    recordPayload(payloadLen, decodedLen, rms, peak, decodeOk) {
        if (this.disabled)
            return;
        // referenced to satisfy noUnusedParameters builds in some configs
        void payloadLen;
        void rms;
        void peak;
        this.totalFrames += 1;
        if (!decodeOk) {
            this.decodeFailures += 1;
        }
        else {
            this.decodedFrames += 1;
        }
        if (decodedLen < DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT)
            this.tinyPayloadFrames += 1;
    }
    recordEmittedChunk(rms, peak) {
        if (this.disabled)
            return;
        this.emittedChunks += 1;
        if (rms < DEFAULT_HEALTH_RMS_FLOOR)
            this.silentFrames += 1;
        this.lastRms = rms;
        this.lastPeak = peak;
        this.rollingRmsWindow.push(rms);
        this.rollingRmsSum += rms;
        if (this.rollingRmsWindow.length > DEFAULT_HEALTH_MIN_EMIT_CHUNKS) {
            const removed = this.rollingRmsWindow.shift();
            if (removed !== undefined)
                this.rollingRmsSum -= removed;
        }
        this.rollingRms = this.rollingRmsWindow.length ? this.rollingRmsSum / this.rollingRmsWindow.length : 0;
    }
    evaluate(now) {
        if (this.disabled || this.evaluated)
            return null;
        if (!this.startedAtMs || !this.endAtMs)
            return null;
        const windowElapsed = now >= this.endAtMs;
        const enoughFrames = this.totalFrames >= DEFAULT_HEALTH_MIN_FRAMES;
        if (!windowElapsed || !enoughFrames)
            return null;
        this.evaluated = true;
        if (this.decodeFailures >= DEFAULT_HEALTH_DECODE_FAILURE_LIMIT)
            return 'decode_failures';
        if (this.tinyPayloadFrames >= DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT)
            return 'tiny_payloads';
        if (this.emittedChunks >= DEFAULT_HEALTH_MIN_EMIT_CHUNKS && this.rollingRms < DEFAULT_HEALTH_RMS_FLOOR) {
            return 'low_rms';
        }
        return null;
    }
    getStats() {
        return {
            totalFrames: this.totalFrames,
            decodedFrames: this.decodedFrames,
            silentFrames: this.silentFrames,
            emittedChunks: this.emittedChunks,
            rollingRms: this.rollingRms,
            tinyPayloadFrames: this.tinyPayloadFrames,
            decodeFailures: this.decodeFailures,
            lastRms: this.lastRms,
            lastPeak: this.lastPeak,
        };
    }
}
exports.MediaIngestHealthMonitor = MediaIngestHealthMonitor;
/* --------------------------------- ingest --------------------------------- */
class MediaIngest {
    constructor(options) {
        this.decodeChain = Promise.resolve();
        this.healthMonitor = new MediaIngestHealthMonitor();
        this.tappedFirstDecoded = false;
        /**
         * ✅ Telnyx PSTN inbound AMR-WB should be treated as Bandwidth-Efficient (BE) as-received.
         * This flag is set at the ingest "policy" layer and enforced downstream in codecDecode.ts.
         */
        this.forceAmrWbBe = false;
        this.forceAmrWbBeLogged = false;
        this.mediaCodecLogged = false;
        this.mediaSchemaLogged = false;
        this.payloadSourceLogged = false;
        this.decodedProbeLogged = false;
        this.rawProbeLogged = false;
        this.amrwbCaptureParseFailedLogged = false;
        this.mediaPayloadDebugCount = 0;
        this.activeStreamId = null;
        this.lastSeqByStream = new Map();
        this.dumpFramesIndex = 0;
        this.dumpFramesDisabled = false;
        this.dumpStartLogged = false;
        this.dumpErrorLogged = false;
        this.amrwbCaptureChain = Promise.resolve();
        this.amrwbCaptureDirReady = false;
        this.amrwbCaptureBeHeaderWritten = false;
        this.amrwbCaptureDisabled = false;
        this.amrwbCaptureErrorLogged = false;
        // ---- AMR-WB adjacent duplicate defense (lag-1) ----
        // Keyed by stream_id + normalizedTrack (inbound/outbound) so streams don't poison each other.
        this.lastAmrwbFrameHashByKey = new Map();
        this.telnyxAdjDupDropped = 0;
        this.telnyxAdjDupKept = 0;
        this.frameSeq = 0;
        this.codecState = {};
        this.lastStatsLogAt = 0;
        this.lastEmitLogAt = 0;
        this.amrwbEmitDebugCount = 0;
        this.amrwbEmitDebugLastLogAt = 0;
        this.restartAttempts = 0;
        this.ingestUnhealthyLogged = false;
        this.rxFramesInbound = 0;
        this.rxFramesOutboundSkipped = 0;
        this.rxFramesUnknownTrackSkipped = 0;
        this.callControlId = options.callControlId;
        this.transportMode = options.transportMode;
        this.expectedTrack = normalizeTelnyxTrack(options.expectedTrack);
        this.acceptCodecs = options.acceptCodecs;
        this.targetSampleRateHz = options.targetSampleRateHz;
        this.allowAmrWb = options.allowAmrWb;
        this.allowG722 = options.allowG722;
        this.allowOpus = options.allowOpus;
        this.logContext = options.logContext;
        this.onFrame = options.onFrame;
        this.onRestartStreaming = options.onRestartStreaming;
        this.onReprompt = options.onReprompt;
        this.isPlaybackActive = options.isPlaybackActive;
        this.isListening = options.isListening;
        this.getLastSpeechStartAtMs = options.getLastSpeechStartAtMs;
        this.onAcceptedPayload = options.onAcceptedPayload;
        const maxRestartAttempts = typeof options.maxRestartAttempts === 'number' && Number.isFinite(options.maxRestartAttempts)
            ? options.maxRestartAttempts
            : 1;
        this.maxRestartAttempts = Math.max(0, maxRestartAttempts);
        this.emitChunkMs = resolveEmitMs();
        this.captureState = initCaptureState(this.callControlId) ?? undefined;
        if (this.captureState) {
            log_1.log.info({ event: 'media_capture_started', call_control_id: this.callControlId, ndjson: this.captureState.ndjsonPath }, 'media capture started');
        }
        this.dumpFramesEnabled = sttDebugDumpFramesEnabled();
        this.dumpFramesMax = sttDebugDumpCount();
        this.dumpFramesDir = sttDebugDumpDir();
        this.amrwbCaptureEnabled = amrwbTruthCaptureEnabled();
        this.amrwbCaptureDir = path_1.default.join(telnyxDebugDir(), this.callControlId);
        // -------------------- AUDIO TAP (debug WAV checkpoints) --------------------
        const tapEnabled = process.env.AUDIO_TAP === '1' || process.env.AUDIO_TAP === 'true' || process.env.AUDIO_TAP === 'yes';
        if (tapEnabled) {
            const secondsToKeepRaw = Number(process.env.AUDIO_TAP_SECONDS || 8);
            const secondsToKeep = Number.isFinite(secondsToKeepRaw) && secondsToKeepRaw > 0 ? secondsToKeepRaw : 8;
            this.audioTap = new debugAudioTap_1.DebugAudioTap({
                enabled: true,
                baseDir: process.env.AUDIO_TAP_DIR?.trim() || telnyxDebugDir(),
                sessionId: this.callControlId,
                sampleRate: this.targetSampleRateHz, // downstream rate
                channels: 1,
                secondsToKeep,
            });
            log_1.log.info({
                event: 'audio_tap_enabled',
                call_control_id: this.callControlId,
                dir: process.env.AUDIO_TAP_DIR?.trim() || telnyxDebugDir(),
                seconds_to_keep: secondsToKeep,
                sample_rate_hz: this.targetSampleRateHz,
            }, 'audio tap enabled');
        }
        log_1.log.info({
            event: 'media_ingest_start',
            call_control_id: this.callControlId,
            transport_mode: this.transportMode,
            expected_track: this.expectedTrack || undefined,
            target_sample_rate_hz: this.targetSampleRateHz,
            accept_codecs: Array.from(this.acceptCodecs),
            ...(this.logContext ?? {}),
        }, 'media ingest start');
    }
    handleBinary(buffer) {
        if (buffer.length === 0)
            return;
        this.handleEncodedPayload(buffer, undefined, undefined, 'binary');
    }
    handleMessage(message) {
        const event = typeof message.event === 'string' ? message.event : undefined;
        const capture = this.captureState;
        if (capture && !capture.stopped) {
            const now = Date.now();
            const eventKey = event ?? 'unknown';
            capture.eventCounts[eventKey] = (capture.eventCounts[eventKey] ?? 0) + 1;
            if (event === 'media' && capture.startedAtMs === undefined) {
                capture.startedAtMs = now;
                capture.endAtMs = now + TELNYX_CAPTURE_WINDOW_MS;
            }
            void appendCaptureRecord(capture, {
                ts: new Date(now).toISOString(),
                call_control_id: this.callControlId,
                ws_event: eventKey,
                message: sanitizeForCapture(message),
            });
            if (!capture.startedAtMs && now - capture.firstEventMs > TELNYX_CAPTURE_WINDOW_MS) {
                finalizeCapture(capture, 'no_media');
            }
            else if (capture.startedAtMs && capture.endAtMs && now > capture.endAtMs) {
                finalizeCapture(capture, 'capture_window_elapsed');
            }
        }
        if (event === 'connected')
            return;
        if (event === 'start') {
            this.handleStartEvent(message);
            return;
        }
        if (event === 'stop') {
            if (this.captureState && !this.captureState.stopped)
                finalizeCapture(this.captureState, 'ws_stop');
            return;
        }
        if (event !== 'media')
            return;
        // -------------------- STREAM ISOLATION (drop old/out-of-order) --------------------
        const msgStreamId = this.getTelnyxStreamId(message);
        const seqNum = this.getTelnyxSequence(message);
        // Adopt if needed
        if (!this.activeStreamId && msgStreamId) {
            this.activeStreamId = msgStreamId;
            this.lastSeqByStream.set(msgStreamId, -1);
            log_1.log.info({
                event: 'telnyx_stream_adopted',
                call_control_id: this.callControlId,
                stream_id: msgStreamId,
                ...(this.logContext ?? {}),
            }, 'adopted Telnyx stream_id from media frame');
        }
        // Drop old stream frames
        if (this.activeStreamId && msgStreamId && msgStreamId !== this.activeStreamId) {
            log_1.log.warn({
                event: 'telnyx_stream_old_frame_dropped',
                call_control_id: this.callControlId,
                stream_id: msgStreamId,
                active_stream_id: this.activeStreamId,
                ...(this.logContext ?? {}),
            }, 'dropping media frame from old Telnyx stream_id (restart overlap defense)');
            return;
        }
        // Drop duplicates/out-of-order by seq
        if (this.activeStreamId && seqNum !== undefined) {
            const last = this.lastSeqByStream.get(this.activeStreamId) ?? -1;
            if (seqNum <= last) {
                log_1.log.warn({
                    event: 'telnyx_seq_dup_or_reorder_dropped',
                    call_control_id: this.callControlId,
                    stream_id: this.activeStreamId,
                    seq: seqNum,
                    last_seq: last,
                    ...(this.logContext ?? {}),
                }, 'dropping duplicate/out-of-order Telnyx media frame by sequence_number');
                return;
            }
            this.lastSeqByStream.set(this.activeStreamId, seqNum);
        }
        // -------------------------------------------------------------------------------
        const media = message.media && typeof message.media === 'object' ? message.media : undefined;
        const mediaData = media?.data && typeof media.data === 'object' ? media.data : undefined;
        const payloadCandidates = [];
        const mediaPayload = this.getString(media?.payload);
        if (mediaPayload)
            payloadCandidates.push({ source: 'media.payload', value: mediaPayload });
        const mediaDataPayload = this.getString(mediaData?.payload);
        if (mediaDataPayload)
            payloadCandidates.push({ source: 'media.data.payload', value: mediaDataPayload });
        const mediaDataString = this.getString(media?.data);
        if (mediaDataString)
            payloadCandidates.push({ source: 'media.data', value: mediaDataString });
        const topPayload = this.getString(message.payload);
        if (topPayload)
            payloadCandidates.push({ source: 'payload', value: topPayload });
        if (payloadCandidates.length === 0) {
            if (capture && !capture.stopped) {
                void appendCaptureRecord(capture, {
                    ts: new Date().toISOString(),
                    call_control_id: this.callControlId,
                    ws_event: 'media',
                    kind: 'media_detail',
                    payload_source: null,
                    payload_len: null,
                    decoded_len: null,
                    note: 'no_payload_candidates',
                });
            }
            return;
        }
        const currentCodec = normalizeCodec(this.mediaEncoding);
        const chosen = pickBestPayloadCandidate(payloadCandidates, currentCodec);
        if (!chosen) {
            if (capture && !capture.stopped) {
                void appendCaptureRecord(capture, {
                    ts: new Date().toISOString(),
                    call_control_id: this.callControlId,
                    ws_event: 'media',
                    kind: 'media_detail',
                    payload_source: null,
                    payload_len: null,
                    decoded_len: null,
                    note: 'no_base64ish_candidates',
                    candidates: payloadCandidates.map((c) => ({ source: c.source, len: c.value.trim().length })),
                });
            }
            return;
        }
        const payloadSource = chosen.source;
        const payload = chosen.value;
        const trackFields = {
            mediaTrack: this.getString(media?.track),
            msgTrack: this.getString(message.track),
            streamTrack: this.getString(message.stream_track),
            dataTrack: this.getString(mediaData?.track),
        };
        const resolvedTrack = trackFields.mediaTrack ?? trackFields.msgTrack ?? trackFields.dataTrack ?? trackFields.streamTrack;
        const normalizedTrack = normalizeTelnyxTrack(resolvedTrack);
        if (mediaSchemaDebugEnabled() && !this.mediaSchemaLogged) {
            this.mediaSchemaLogged = true;
            log_1.log.info({
                event: 'media_schema',
                call_control_id: this.callControlId,
                top_level_keys: Object.keys(message),
                media_keys: media ? Object.keys(media) : null,
                has_media_payload: typeof media?.payload === 'string',
                media_payload_len: typeof media?.payload === 'string' ? media.payload.length : null,
                has_top_payload: typeof message.payload === 'string',
                top_payload_len: typeof message.payload === 'string' ? message.payload.length : null,
                possible_alt_paths: {
                    media_data_keys: mediaData ? Object.keys(mediaData) : null,
                    media_data_payload_type: typeof mediaData?.payload === 'string' ? 'string' : typeof mediaData?.payload,
                    media_data_payload_len: typeof mediaData?.payload === 'string' ? mediaData.payload.length : null,
                },
                track_fields: {
                    media_track: media?.track,
                    msg_track: message.track,
                    stream_track: message.stream_track,
                    data_track: mediaData?.track,
                },
                timestamp: typeof media?.timestamp === 'number' ? media.timestamp : null,
            }, 'media schema');
        }
        if (!this.payloadSourceLogged) {
            this.payloadSourceLogged = true;
            log_1.log.info({
                event: 'media_payload_source',
                call_control_id: this.callControlId,
                payload_source: payloadSource,
                payload_len: payload.trim().length,
                codec: currentCodec,
                track: resolvedTrack ?? null,
                ...(this.logContext ?? {}),
            }, 'media payload source selected');
        }
        // --------------------------------------------------------------------------------
        // Prefer Telnyx seq if present; fall back to a local monotonic counter.
        // IMPORTANT: do NOT bump local counter until we know we’re keeping the frame.
        // --------------------------------------------------------------------------------
        const telnyxSeq = seqNum; // already computed above via getTelnyxSequence(message)
        const seqForPipeline = typeof telnyxSeq === 'number' && Number.isFinite(telnyxSeq) ? telnyxSeq : undefined;
        // We still keep a local counter for when Telnyx seq is missing.
        // NOTE: we will assign it later (after gating) only if needed.
        let localSeqAssigned;
        // --------------------------------------------------------------
        // decode base64 -> bytes (NO hashing yet)
        // --------------------------------------------------------------
        let buffer;
        let encodingUsed = 'base64';
        let trimmedPayload = payload.trim();
        const payloadLooksBase64 = looksLikeBase64(trimmedPayload);
        const base64Len = trimmedPayload.length;
        try {
            const decoded = decodeTelnyxPayloadWithInfo(trimmedPayload);
            buffer = decoded.buffer;
            encodingUsed = decoded.encoding;
            trimmedPayload = decoded.trimmed;
        }
        catch (error) {
            this.logMediaPayloadDebug(base64Len, null, payloadSource, 'decode_failed');
            log_1.log.warn({ event: 'media_ws_decode_failed', call_control_id: this.callControlId, err: error }, 'media ws decode failed');
            return;
        }
        // NOTE: currentCodec was already computed earlier (do NOT redeclare it here).
        // Use the existing variable that was used for candidate selection.
        // const currentCodec = normalizeCodec(this.mediaEncoding);
        // basic "decoded bytes too short" gate (same as your existing logic)
        const minDecodedLen = currentCodec === 'AMR-WB' ? 2 : 10;
        if (buffer.length < minDecodedLen) {
            log_1.log.info({
                event: 'media_payload_suspicious',
                call_control_id: this.callControlId,
                codec: currentCodec,
                payload_len: trimmedPayload.length,
                decoded_len: buffer.length,
                payload_source: payloadSource,
                telnyx_seq: seqForPipeline ?? null,
                ...(this.logContext ?? {}),
            }, 'media payload too short');
            this.healthMonitor.recordPayload(trimmedPayload.length, buffer.length, 0, 0, false);
            this.checkHealth(currentCodec);
            return;
        }
        // track gating FIRST (so outbound frames never enter dedupe or decode path)
        if (this.expectedTrack && this.expectedTrack !== 'both_tracks' && normalizedTrack && this.expectedTrack !== normalizedTrack) {
            if (normalizedTrack === 'outbound')
                this.rxFramesOutboundSkipped += 1;
            else
                this.rxFramesUnknownTrackSkipped += 1;
            log_1.log.info({
                event: 'media_track_skipped',
                call_control_id: this.callControlId,
                expected_track: this.expectedTrack,
                got_track: normalizedTrack,
                telnyx_seq: seqForPipeline ?? null,
                bytes: buffer.length,
                ...(this.logContext ?? {}),
            }, 'media track skipped');
            return;
        }
        if (normalizedTrack === 'inbound')
            this.rxFramesInbound += 1;
        // Assign local seq only after we know we’re keeping the frame.
        if (seqForPipeline === undefined) {
            this.frameSeq += 1;
            localSeqAssigned = this.frameSeq;
        }
        // Canonical seq used everywhere downstream.
        const finalSeq = seqForPipeline ?? localSeqAssigned;
        // --------------------------------------------------------------
        // AMR-WB adjacent-frame dedupe (lag-1 only, per stream+track)
        // --------------------------------------------------------------
        if (currentCodec === 'AMR-WB') {
            const dedupeKey = `${this.callControlId}:${this.activeStreamId ?? 'nostream'}:${normalizedTrack ?? 'notrack'}`;
            const h = crypto_1.default.createHash('sha1').update(buffer).digest(); // Buffer(20)
            const prev = this.lastAmrwbFrameHashByKey.get(dedupeKey);
            if (prev && prev.equals(h)) {
                this.telnyxAdjDupDropped += 1;
                log_1.log.warn({
                    event: 'amrwb_adjacent_duplicate_dropped',
                    call_control_id: this.callControlId,
                    stream_id: this.activeStreamId ?? null,
                    track: normalizedTrack ?? null,
                    seq: finalSeq,
                    dropped_total: this.telnyxAdjDupDropped,
                    kept_total: this.telnyxAdjDupKept,
                    ...(this.logContext ?? {}),
                }, 'dropping adjacent duplicate AMR-WB frame');
                return;
            }
            this.lastAmrwbFrameHashByKey.set(dedupeKey, h);
            this.telnyxAdjDupKept += 1;
        }
        // --------------------------------------------------------------------------
        // From this point on, ALWAYS use finalSeq (not this.frameSeq)
        // --------------------------------------------------------------------------
        void this.maybeDumpMediaFrame(trimmedPayload, buffer);
        this.queueAmrwbTruthCapture(buffer, finalSeq);
        this.logMediaPayloadDebug(base64Len, buffer, payloadSource);
        void dumpTelnyxRawPayload(this.callControlId, trimmedPayload);
        if (capture && !capture.stopped) {
            const payloadLen = trimmedPayload.length;
            capture.frameCount += 1;
            const isTinyForCapture = currentCodec === 'AMR-WB' ? buffer.length < 6 : payloadLen < TELNYX_CAPTURE_TINY_PAYLOAD_LEN;
            if (isTinyForCapture)
                capture.tinyPayloadFrames += 1;
            if (payloadLooksBase64)
                capture.payloadBase64Frames += 1;
            else
                capture.payloadNotBase64Frames += 1;
            capture.payloadSources.add(payloadSource);
            capture.payloadSourceCounts[payloadSource] = (capture.payloadSourceCounts[payloadSource] ?? 0) + 1;
            incrementBucket(capture.payloadLenBuckets, payloadLen);
            incrementBucket(capture.decodedLenBuckets, buffer.length);
            const trackCombo = `media:${normalizeTelnyxTrack(trackFields.mediaTrack)}|msg:${normalizeTelnyxTrack(trackFields.msgTrack)}|stream:${normalizeTelnyxTrack(trackFields.streamTrack)}|data:${normalizeTelnyxTrack(trackFields.dataTrack)}`;
            capture.trackCombos.add(trackCombo);
            const payloadPrefix = redactInline(trimmedPayload.slice(0, 64));
            const decodedPrefixHex = buffer.subarray(0, 32).toString('hex');
            const timestamp = typeof media?.timestamp === 'number' ? media.timestamp : undefined;
            const notAudio = currentCodec === 'AMR-WB' ? buffer.length < 20 : buffer.length < 10;
            if (notAudio)
                capture.notAudioFrames += 1;
            const amrwbParse = currentCodec === 'AMR-WB' ? debugParseAmrWbPayload(buffer) : null;
            if (!amrwbParse?.ok && amrwbParse && !this.amrwbCaptureParseFailedLogged) {
                this.amrwbCaptureParseFailedLogged = true;
                log_1.log.warn({
                    event: 'amrwb_capture_parse_failed',
                    call_control_id: this.callControlId,
                    reason: amrwbParse.reason ?? 'unknown',
                    payload_len: buffer.length,
                    payload_prefix_hex: decodedPrefixHex,
                    attempts: amrwbParse.attempts?.map((attempt) => ({
                        offset: attempt.offset,
                        reason: attempt.reason ?? null,
                        invalid_ft: attempt.invalidFt ?? null,
                    })),
                }, 'amr-wb capture parse failed');
            }
            if (capture.mediaExamples.length < 2)
                capture.mediaExamples.push(sanitizeForCapture(message));
            void appendCaptureRecord(capture, {
                ts: new Date().toISOString(),
                call_control_id: this.callControlId,
                ws_event: 'media',
                kind: 'media_detail',
                payload_source: payloadSource,
                payload_len: payloadLen,
                payload_prefix: payloadPrefix,
                decoded_len: buffer.length,
                decoded_prefix_hex: decodedPrefixHex,
                encoding_used: encodingUsed,
                track_fields: {
                    media_track: trackFields.mediaTrack ?? null,
                    msg_track: trackFields.msgTrack ?? null,
                    stream_track: trackFields.streamTrack ?? null,
                    data_track: trackFields.dataTrack ?? null,
                    resolved_track: resolvedTrack ?? null,
                },
                seq: finalSeq,
                timestamp,
                payload_base64: payloadLooksBase64,
                not_audio: notAudio,
                amrwb_parse: amrwbParse,
            });
            void dumpCaptureFrame(capture, this.callControlId, finalSeq, trimmedPayload);
            if (capture.startedAtMs && (Date.now() > (capture.endAtMs ?? 0) || capture.frameCount >= TELNYX_CAPTURE_MAX_FRAMES)) {
                finalizeCapture(capture, 'capture_window_elapsed');
            }
            else if (capture.tinyPayloadFrames >= TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT && currentCodec !== 'AMR-WB') {
                finalizeCapture(capture, 'tiny_payloads_exceeded');
            }
        }
        // ✅ accepted payload tap (post-gating)
        try {
            this.onAcceptedPayload?.({
                callControlId: this.callControlId,
                codec: currentCodec,
                track: resolvedTrack ?? null,
                normalizedTrack: normalizedTrack || null,
                seq: finalSeq,
                timestamp: typeof media?.timestamp === 'number' ? media.timestamp : null,
                payloadSource: payloadSource ?? null,
                payloadLen: trimmedPayload.length,
                decodedLen: buffer.length,
                hexPrefix: buffer.subarray(0, 24).toString('hex'),
                playbackActive: this.isPlaybackActive?.(),
                listening: this.isListening?.(),
                lastSpeechStartAtMs: this.getLastSpeechStartAtMs?.() ?? null,
            });
        }
        catch (error) {
            log_1.log.warn({
                event: 'media_ingest_onAcceptedPayload_failed',
                call_control_id: this.callControlId,
                err: error,
                ...(this.logContext ?? {}),
            }, 'media ingest onAcceptedPayload hook failed');
        }
        // decode pipeline: use finalSeq
        this.handleEncodedPayload(buffer, typeof media?.timestamp === 'number' ? media.timestamp : undefined, finalSeq, payloadSource);
    }
    close(reason) {
        if (this.captureState && !this.captureState.stopped)
            finalizeCapture(this.captureState, reason);
        this.decodeChain = this.decodeChain
            .then(() => this.flushPendingPcm(reason))
            .catch((err) => {
            log_1.log.warn({ event: 'media_ingest_flush_pending_failed', call_control_id: this.callControlId, err, ...(this.logContext ?? {}) }, 'media ingest flush pending failed');
        })
            .then(() => {
            (0, codecDecode_1.closeTelnyxCodecState)(this.codecState);
        });
    }
    /* --------------------------- AMR-WB BE truth capture -------------------------- */
    // AMR-WB storage (AWB) frames are: [1-byte frame header] + [speech bytes]
    // Telnyx BE RTP single-frame payloads are: [1-byte TOC] + [speech bytes]
    buildBeConvertedCandidate(payload) {
        // Only accept the Telnyx single-frame BE speech packets we observed.
        if (payload.length !== 33)
            return null;
        const toc = payload[0] ?? 0;
        const ft = (toc >> 3) & 0x0f; // frame type
        const q = (toc & 0x04) !== 0; // quality bit
        // Reject non-speech / invalid
        if (ft >= 10 && ft <= 13)
            return null; // invalid reserved
        if (ft === 14 || ft === 15)
            return null; // speech lost / no data
        const speech = payload.subarray(1);
        // For payload_len=33, the only valid speech size is 32 bytes (WB FT=2)
        if (speech.length !== 32)
            return null;
        // AWB frame header byte: (FT << 3) | Qbit(0x04)
        const awbHdr = ((ft & 0x0f) << 3) | (q ? 0x04 : 0x00);
        return Buffer.concat([Buffer.from([awbHdr]), speech]);
    }
    logAmrwbCaptureErrorOnce(error, note) {
        if (this.amrwbCaptureErrorLogged)
            return;
        this.amrwbCaptureErrorLogged = true;
        log_1.log.warn({ event: 'amrwb_truth_capture_error', call_control_id: this.callControlId, note, err: error, ...(this.logContext ?? {}) }, 'amrwb truth capture failed');
    }
    queueAmrwbTruthCapture(payload, frameIndex) {
        if (!this.amrwbCaptureEnabled || this.amrwbCaptureDisabled)
            return;
        this.amrwbCaptureChain = this.amrwbCaptureChain
            .then(() => this.captureAmrwbTruthPayload(payload, frameIndex))
            .catch((error) => {
            this.amrwbCaptureDisabled = true;
            this.logAmrwbCaptureErrorOnce(error, 'capture');
        });
    }
    async captureAmrwbTruthPayload(payload, frameIndex) {
        if (!this.amrwbCaptureEnabled || this.amrwbCaptureDisabled)
            return;
        if (!this.amrwbCaptureDirReady) {
            try {
                await fs_1.default.promises.mkdir(this.amrwbCaptureDir, { recursive: true });
            }
            catch (error) {
                this.amrwbCaptureDisabled = true;
                this.logAmrwbCaptureErrorOnce(error, 'mkdir');
                return;
            }
            this.amrwbCaptureDirReady = true;
        }
        const rawPath = path_1.default.join(this.amrwbCaptureDir, 'raw_frames.bin');
        const bePath = path_1.default.join(this.amrwbCaptureDir, 'be_converted.awb');
        try {
            if (!this.amrwbCaptureBeHeaderWritten) {
                await fs_1.default.promises.writeFile(bePath, AMRWB_FILE_HEADER);
                this.amrwbCaptureBeHeaderWritten = true;
            }
            await fs_1.default.promises.appendFile(rawPath, payload);
        }
        catch (error) {
            this.amrwbCaptureDisabled = true;
            this.logAmrwbCaptureErrorOnce(error, 'write_raw');
            return;
        }
        // ✅ Gate BE capture: only speech frames (33 bytes) should be appended
        const isSpeech = isLikelyAmrwbSpeechPayload(payload);
        let beAppended = false;
        let droppedNonSpeech = false;
        // NEW: explain WHY we did/didn’t append
        let beCandidateOk = false;
        let beCandidateReason = null;
        // NEW: tiny sanity sniff so we know what “shape” this payload is
        const firstByte = payload.length > 0 ? payload[0] : null;
        const firstByteHiNibble = firstByte === null ? null : (firstByte >> 4) & 0x0f;
        const tocFt = firstByte === null ? null : (firstByte >> 3) & 0x0f;
        const tocQ = firstByte === null ? null : (firstByte & 0x04) !== 0;
        if (!isSpeech) {
            droppedNonSpeech = true;
            beCandidateReason = 'not_len_33';
        }
        else {
            const beCandidate = this.buildBeConvertedCandidate(payload);
            if (!beCandidate) {
                beCandidateReason = 'build_candidate_returned_null';
            }
            else {
                beCandidateOk = true;
                try {
                    await fs_1.default.promises.appendFile(bePath, beCandidate);
                    beAppended = true;
                }
                catch (error) {
                    this.amrwbCaptureDisabled = true;
                    this.logAmrwbCaptureErrorOnce(error, 'write_be');
                    beCandidateReason = 'append_be_failed';
                }
            }
        }
        const first8Hex = getHexPrefix(payload, 8);
        log_1.log.info({
            event: 'amrwb_truth_capture_frame',
            call_control_id: this.callControlId,
            frame_index: frameIndex,
            payload_len: payload.length,
            first8_hex: first8Hex,
            // what we decided
            is_speech: isSpeech,
            dropped_non_speech: droppedNonSpeech,
            be_candidate_ok: beCandidateOk,
            be_candidate_reason: beCandidateReason,
            // what the bytes look like (tells us if this is really [TOC + 32])
            first_byte: firstByte,
            first_byte_hi_nibble: firstByteHiNibble,
            toc_ft: tocFt,
            toc_q: tocQ,
            appended_streams: {
                raw: true,
                be: beAppended,
            },
            ...(this.logContext ?? {}),
        }, `amrwb truth capture callId=${this.callControlId} frame_index=${frameIndex} payload_len=${payload.length} first8_hex=${first8Hex} speech=${isSpeech} be_ok=${beCandidateOk} be_reason=${beCandidateReason} appended_be=${beAppended}`);
    }
    /* ------------------------------ low-level helpers ----------------------------- */
    getTelnyxStreamId(message) {
        const media = message.media && typeof message.media === 'object' ? message.media : undefined;
        const start = message.start && typeof message.start === 'object' ? message.start : undefined;
        return (this.getString(message.stream_id) ||
            this.getString(message.streamId) ||
            this.getString(media?.stream_id) ||
            this.getString(media?.streamId) ||
            this.getString(start?.stream_id) ||
            this.getString(start?.streamId));
    }
    getTelnyxSequence(message) {
        const media = message.media && typeof message.media === 'object' ? message.media : undefined;
        const mediaData = media?.data && typeof media.data === 'object' ? media.data : undefined;
        return (this.getNumber(message.sequence_number) ??
            this.getNumber(message.sequenceNumber) ??
            this.getNumber(media?.sequence_number) ??
            this.getNumber(media?.sequenceNumber) ??
            this.getNumber(mediaData?.sequence_number) ??
            this.getNumber(mediaData?.sequenceNumber));
    }
    getString(value) {
        return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    }
    getNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }
    /* ------------------------------ dump frames ----------------------------- */
    dumpFramesActive() {
        return this.dumpFramesEnabled && !this.dumpFramesDisabled;
    }
    dumpFramesDirForCall() {
        const token = this.callControlId ? safeFileToken(this.callControlId) : `session_${Date.now()}`;
        return path_1.default.join(this.dumpFramesDir, token);
    }
    logDumpErrorOnce(error, note) {
        if (this.dumpErrorLogged)
            return;
        this.dumpErrorLogged = true;
        log_1.log.warn({ event: 'media_dump_error', call_control_id: this.callControlId, note, err: error, ...(this.logContext ?? {}) }, 'media dump failed');
    }
    guessDumpKind(raw) {
        if (looksLikeAmrWbMagic(raw))
            return 'amrwb_magic';
        if (looksLikeTelnyxNoCmrToc33(raw))
            return 'amrwb_toc_like';
        if (looksLikeWavRiff(raw))
            return 'wav_riff';
        return 'unknown';
    }
    maybeDumpStartEvent(message) {
        if (!this.dumpFramesActive() || this.dumpStartLogged)
            return;
        this.dumpStartLogged = true;
        const dir = this.dumpFramesDirForCall();
        const sanitized = sanitizeForCapture(message);
        void fs_1.default.promises
            .mkdir(dir, { recursive: true })
            .then(() => fs_1.default.promises.writeFile(path_1.default.join(dir, 'telnyx_start.json'), `${JSON.stringify(sanitized, null, 2)}\n`))
            .catch((error) => this.logDumpErrorOnce(error, 'start_event'));
        log_1.log.info({ event: 'telnyx_start_dump', call_control_id: this.callControlId, start: sanitized, ...(this.logContext ?? {}) }, 'telnyx start event (sanitized)');
    }
    async maybeDumpMediaFrame(base64Payload, raw) {
        if (!this.dumpFramesActive())
            return;
        if (this.dumpFramesIndex >= this.dumpFramesMax)
            return;
        const idx = this.dumpFramesIndex + 1;
        this.dumpFramesIndex = idx;
        const dir = this.dumpFramesDirForCall();
        try {
            await fs_1.default.promises.mkdir(dir, { recursive: true });
        }
        catch (error) {
            this.dumpFramesDisabled = true;
            this.logDumpErrorOnce(error, 'mkdir');
            return;
        }
        const padded = String(idx).padStart(4, '0');
        const basePath = path_1.default.join(dir, `frame_${padded}`);
        const rawHex16 = getHexPrefix(raw, 16);
        const guessedKind = this.guessDumpKind(raw);
        let prepared = null;
        let preparedHex16 = null;
        if (guessedKind === 'amrwb_magic' || guessedKind === 'amrwb_toc_like') {
            const prep = (0, prepareAmrWbPayload_1.prepareAmrWbPayload)(raw);
            prepared = prep.prepared;
            preparedHex16 = getHexPrefix(prepared, 16);
        }
        try {
            await fs_1.default.promises.writeFile(`${basePath}.b64.txt`, base64Payload);
            await fs_1.default.promises.writeFile(`${basePath}.raw.bin`, raw);
            if (prepared) {
                await fs_1.default.promises.writeFile(`${basePath}.prepared.bin`, prepared);
            }
        }
        catch (error) {
            this.dumpFramesDisabled = true;
            this.logDumpErrorOnce(error, 'write');
            return;
        }
        log_1.log.info({
            event: 'media_dump',
            call_control_id: this.callControlId,
            idx,
            b64_len: base64Payload.length,
            raw_len: raw.length,
            raw_hex16: rawHex16,
            prepared_len: prepared?.length ?? null,
            prepared_hex16: preparedHex16,
            guessed_kind: guessedKind,
            ...(this.logContext ?? {}),
        }, `[MEDIA_DUMP] idx=${idx} b64Len=${base64Payload.length} rawLen=${raw.length} rawHex16=${rawHex16} preparedLen=${prepared?.length ?? 'n/a'} preparedHex16=${preparedHex16 ?? 'n/a'} guessedKind=${guessedKind}`);
    }
    /* ------------------------------ policy: force BE ----------------------------- */
    maybeEnableForceBe(encoding, source) {
        if (this.forceAmrWbBe)
            return;
        if (this.transportMode !== 'pstn')
            return;
        if (encoding !== 'AMR-WB')
            return;
        this.forceAmrWbBe = true;
        if (!this.forceAmrWbBeLogged) {
            this.forceAmrWbBeLogged = true;
            log_1.log.info({
                event: 'amrwb_force_be_enabled',
                call_control_id: this.callControlId,
                transport_mode: this.transportMode,
                codec: encoding,
                source,
                ...(this.logContext ?? {}),
            }, 'forcing AMR-WB Bandwidth-Efficient (BE) decode for Telnyx PSTN (no CMR strip / no repack)');
        }
    }
    /* ------------------------------ start event ----------------------------- */
    handleStartEvent(message) {
        this.maybeDumpStartEvent(message);
        const start = message.start && typeof message.start === 'object' ? message.start : {};
        const streamId = this.getString(start.stream_id) ?? this.getString(message.stream_id);
        if (streamId) {
            this.activeStreamId = streamId;
            this.lastSeqByStream.set(streamId, -1);
            log_1.log.info({ event: 'telnyx_stream_active', call_control_id: this.callControlId, stream_id: streamId, ...(this.logContext ?? {}) }, 'active stream set');
        }
        // Reset per-call adjacent AMR-WB dedupe state
        this.lastAmrwbFrameHashByKey.clear();
        this.telnyxAdjDupDropped = 0;
        this.telnyxAdjDupKept = 0;
        const mediaFormat = start.media_format ??
            message.media_format ??
            undefined;
        const encoding = mediaFormat ? this.getString(mediaFormat.encoding) : undefined;
        const sampleRate = mediaFormat && typeof mediaFormat.sample_rate === 'number'
            ? mediaFormat.sample_rate
            : mediaFormat && typeof mediaFormat.sampleRate === 'number'
                ? mediaFormat.sampleRate
                : undefined;
        const channels = mediaFormat ? this.getNumber(mediaFormat.channels) : undefined;
        let normalizedEncoding = normalizeCodec(encoding ?? this.mediaEncoding);
        // Optional: force PSTN to AMR-WB
        if (this.transportMode === 'pstn' &&
            parseBoolEnv(process.env.TELNYX_FORCE_AMRWB_PSTN) &&
            this.allowAmrWb &&
            this.acceptCodecs.has('AMR-WB')) {
            normalizedEncoding = 'AMR-WB';
            this.pinnedCodec = 'AMR-WB';
        }
        if (encoding || !this.mediaEncoding) {
            this.mediaEncoding = normalizedEncoding;
            this.mediaSampleRate = sampleRate ?? (normalizedEncoding === 'AMR-WB' ? 16000 : undefined);
            this.mediaChannels = channels;
        }
        // ✅ If this is Telnyx PSTN AMR-WB, declare "BE as received" at ingest layer.
        this.maybeEnableForceBe(normalizedEncoding, 'start');
        if (!this.mediaCodecLogged) {
            this.mediaCodecLogged = true;
            log_1.log.info({
                event: 'media_ingest_codec_detected',
                call_control_id: this.callControlId,
                codec: normalizedEncoding,
                sample_rate: this.mediaSampleRate,
                channels,
                ...(this.logContext ?? {}),
            }, 'media ingest codec detected');
        }
        this.healthMonitor.start(Date.now());
    }
    isCodecSupported(codec) {
        if (!this.acceptCodecs.has(codec))
            return { supported: false, reason: 'codec_not_accepted' };
        if (codec === 'AMR-WB' && !this.allowAmrWb)
            return { supported: false, reason: 'amrwb_decode_disabled' };
        if (codec === 'G722' && !this.allowG722)
            return { supported: false, reason: 'g722_decode_disabled' };
        if (codec === 'OPUS' && !this.allowOpus)
            return { supported: false, reason: 'opus_decode_disabled' };
        return { supported: true };
    }
    /* ------------------------------ ingest core ----------------------------- */
    handleEncodedPayload(buffer, timestamp, seq, payloadSource) {
        if (!this.mediaEncoding) {
            log_1.log.warn({
                event: 'media_ingest_codec_defaulted',
                call_control_id: this.callControlId,
                assumed_codec: 'AMR-WB',
                reason: 'mediaEncoding unset (media_format.encoding missing or start not processed yet)',
                payload_len: buffer.length,
                seq,
                timestamp,
                payloadSource,
                ...(this.logContext ?? {}),
            }, 'media ingest codec defaulted (no mediaEncoding set)');
        }
        const explicit = this.mediaEncoding;
        let encoding = normalizeCodec(explicit);
        if (this.pinnedCodec) {
            encoding = this.pinnedCodec;
        }
        // ✅ If we defaulted to AMR-WB on PSTN, still lock BE policy here.
        this.maybeEnableForceBe(encoding, explicit ? 'payload' : 'defaulted');
        const support = this.isCodecSupported(encoding);
        if (!support.supported) {
            log_1.log.warn({
                event: 'media_ingest_codec_unsupported',
                call_control_id: this.callControlId,
                encoding,
                reason: support.reason,
                ...(this.logContext ?? {}),
            }, 'media ingest codec unsupported');
            this.healthMonitor.recordPayload(buffer.length, buffer.length, 0, 0, false);
            this.checkHealth(encoding);
            return;
        }
        if (!this.rawProbeLogged) {
            this.rawProbeLogged = true;
            const meta = {
                callId: this.callControlId,
                format: encoding === 'PCMU' ? 'pcmu' : encoding === 'PCMA' ? 'alaw' : undefined,
                codec: encoding,
                sampleRateHz: this.mediaSampleRate,
                channels: this.mediaChannels ?? 1,
                bitDepth: encoding === 'PCMU' || encoding === 'PCMA' ? 8 : undefined,
                logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
                lineage: ['rx.telnyx.raw'],
            };
            (0, audioProbe_1.attachAudioMeta)(buffer, meta);
            if ((0, audioProbe_1.diagnosticsEnabled)()) {
                if (encoding === 'PCMU' || encoding === 'PCMA') {
                    (0, audioProbe_1.probePcm)('rx.telnyx.raw', buffer, meta);
                }
                else {
                    log_1.log.info({
                        event: 'audio_probe_skipped',
                        call_control_id: this.callControlId,
                        encoding,
                        sample_rate: this.mediaSampleRate,
                        channels: this.mediaChannels ?? 1,
                        ...(this.logContext ?? {}),
                    }, 'audio probe skipped for non-PCM codec');
                }
            }
            (0, audioProbe_1.markAudioSpan)('rx', meta);
        }
        this.decodeChain = this.decodeChain
            .then(() => this.decodeAndEmit(buffer, encoding, timestamp, seq, payloadSource))
            .catch((err) => {
            log_1.log.warn({ event: 'media_ingest_decode_chain_error', call_control_id: this.callControlId, err, ...(this.logContext ?? {}) }, 'media ingest decode chain error');
        });
    }
    flushPendingPcm(reason) {
        if (!this.pendingPcm || this.pendingPcm.length === 0)
            return;
        const pending = this.pendingPcm;
        const sampleRateHz = this.pendingPcmSampleRateHz ?? this.targetSampleRateHz;
        this.pendingPcm = undefined;
        this.pendingPcmSampleRateHz = undefined;
        this.maybeLogEmitDebug(pending, pending, sampleRateHz, undefined, `flush_${reason}`);
        if (this.audioTap && pending.length > 0) {
            const frameBuf = Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength);
            this.audioTap.push('EMITTED_BUFFERED', frameBuf);
        }
        if (!this.decodedProbeLogged && (0, audioProbe_1.diagnosticsEnabled)()) {
            this.decodedProbeLogged = true;
            const pcmBuffer = Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength);
            const meta = {
                callId: this.callControlId,
                format: 'pcm16le',
                codec: this.mediaEncoding ?? 'unknown',
                sampleRateHz,
                channels: 1,
                bitDepth: 16,
                logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
                lineage: ['rx.decoded.pcm16'],
            };
            (0, audioProbe_1.attachAudioMeta)(pcmBuffer, meta);
            (0, audioProbe_1.probePcm)('rx.decoded.pcm16', pcmBuffer, meta);
        }
        this.onFrame({
            callControlId: this.callControlId,
            pcm16: pending,
            sampleRateHz,
            channels: 1,
        });
    }
    maybeLogEmitDebug(accumulated, emitted, sampleRateHz, seq, note) {
        if (!emitChunkDebugEnabled())
            return;
        const now = Date.now();
        if (now - this.lastEmitLogAt < 1000)
            return;
        this.lastEmitLogAt = now;
        try {
            const accumulatedStats = computePcmStats(accumulated);
            const emittedStats = computePcmStats(emitted);
            const accumulatedMs = Math.round((accumulated.length / sampleRateHz) * 1000);
            const emittedMs = Math.round((emitted.length / sampleRateHz) * 1000);
            log_1.log.info({
                event: 'media_ingest_emit_debug',
                call_control_id: this.callControlId,
                frame_seq: seq ?? null,
                sample_rate_hz: sampleRateHz,
                accumulated_samples: accumulated.length,
                accumulated_ms: accumulatedMs,
                accumulated_rms: Number(accumulatedStats.rms.toFixed(6)),
                accumulated_peak: Number(accumulatedStats.peak.toFixed(6)),
                emitted_samples: emitted.length,
                emitted_ms: emittedMs,
                emitted_rms: Number(emittedStats.rms.toFixed(6)),
                emitted_peak: Number(emittedStats.peak.toFixed(6)),
                emit_chunk_ms: this.emitChunkMs,
                note: note ?? null,
                ...(this.logContext ?? {}),
            }, 'media ingest buffered emit');
        }
        catch (error) {
            log_1.log.warn({ event: 'media_ingest_emit_debug_failed', call_control_id: this.callControlId, err: error, ...(this.logContext ?? {}) }, 'media ingest emit debug failed');
        }
    }
    shouldLogAmrwbEmitDebug(now) {
        if (this.amrwbEmitDebugCount < AMRWB_EMIT_DEBUG_MAX) {
            this.amrwbEmitDebugCount += 1;
            this.amrwbEmitDebugLastLogAt = now;
            return true;
        }
        if (now - this.amrwbEmitDebugLastLogAt >= AMRWB_EMIT_DEBUG_INTERVAL_MS) {
            this.amrwbEmitDebugLastLogAt = now;
            return true;
        }
        return false;
    }
    countNearZeroSamples(samples, threshold) {
        let zero = 0;
        let nearZero = 0;
        for (let i = 0; i < samples.length; i += 1) {
            const value = samples[i] ?? 0;
            if (value === 0)
                zero += 1;
            if (Math.abs(value) <= threshold)
                nearZero += 1;
        }
        return { zero, nearZero };
    }
    logMediaPayloadDebug(base64Len, buffer, payloadSource, note) {
        if (this.mediaPayloadDebugCount >= 20)
            return;
        this.mediaPayloadDebugCount += 1;
        try {
            const decodedLen = buffer ? buffer.length : null;
            const decodedPrefixHex = buffer ? buffer.subarray(0, 16).toString('hex') : null;
            log_1.log.info({
                event: 'media_payload_debug',
                call_control_id: this.callControlId,
                payload_source: payloadSource ?? null,
                base64_len: base64Len,
                decoded_len: decodedLen,
                decoded_prefix_hex: decodedPrefixHex,
                note: note ?? (buffer ? undefined : 'decoded_payload_unavailable'),
                frame_seq: this.frameSeq,
                ...(this.logContext ?? {}),
            }, buffer ? 'MEDIA_PAYLOAD_DEBUG raw payload' : 'MEDIA_PAYLOAD_DEBUG decoded payload unavailable');
        }
        catch (error) {
            log_1.log.warn({ event: 'media_payload_debug_failed', call_control_id: this.callControlId, err: error, ...(this.logContext ?? {}) }, 'MEDIA_PAYLOAD_DEBUG logging failed');
        }
    }
    async decodeAndEmit(buffer, encoding, timestamp, seq, payloadSource) {
        let decodeOk = false;
        let rms = 0;
        let peak = 0;
        const decodeResult = await (0, codecDecode_1.decodeTelnyxPayloadToPcm16)({
            encoding,
            payload: buffer,
            channels: this.mediaChannels ?? 1,
            reportedSampleRateHz: this.mediaSampleRate,
            targetSampleRateHz: this.targetSampleRateHz,
            allowAmrWb: this.allowAmrWb,
            allowG722: this.allowG722,
            allowOpus: this.allowOpus,
            state: this.codecState,
            logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
            // ✅ enforce Telnyx PSTN AMR-WB as Bandwidth-Efficient (BE) "as received".
            forceAmrWbBe: this.forceAmrWbBe,
        });
        if (!decodeResult) {
            // Don't mark AMR-WB frames as "tiny" just because decode failed.
            const pseudoDecodedLen = encoding === 'AMR-WB' ? 999 : 0;
            this.healthMonitor.recordPayload(buffer.length, pseudoDecodedLen, 0, 0, false);
            this.checkHealth(encoding);
            return;
        }
        const pcm16 = decodeResult.pcm16;
        // -------------------- AUDIO TAP: decoded PCM (pre-framing) --------------------
        if (this.audioTap && pcm16.length > 0) {
            const pcmBuf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
            this.audioTap.push('IN_DECODED_PCM', pcmBuf);
            if (!this.tappedFirstDecoded) {
                this.tappedFirstDecoded = true;
                this.audioTap.flush('IN_DECODED_PCM', 'first_decode');
            }
        }
        // -------------------- DEBUG CAPTURE: full decoded PCM --------------------
        const shouldDumpDecoded = telnyxTapRawEnabled() || (this.captureState && !this.captureState.stopped);
        if (shouldDumpDecoded && pcm16.length > 0) {
            const decodedBuf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
            const seqForDump = typeof seq === 'number' && Number.isFinite(seq) ? seq : this.frameSeq;
            const capture = this.captureState;
            if (capture && !capture.stopped) {
                void dumpCaptureDecodedPcm(capture, this.callControlId, seqForDump, decodedBuf);
            }
            void dumpTelnyxDecodedPcm(this.callControlId, seqForDump, decodedBuf);
        }
        if (pcm16.length > 0) {
            const stats = computePcmStats(pcm16);
            rms = stats.rms;
            peak = stats.peak;
        }
        decodeOk = true;
        const sampleRateHz = decodeResult.sampleRateHz;
        if (this.pendingPcm &&
            this.pendingPcm.length > 0 &&
            this.pendingPcmSampleRateHz &&
            this.pendingPcmSampleRateHz !== sampleRateHz) {
            this.flushPendingPcm('sample_rate_changed');
        }
        const emitSamples = Math.max(1, Math.round((sampleRateHz * this.emitChunkMs) / 1000));
        let combined = pcm16;
        if (this.pendingPcm && this.pendingPcm.length > 0) {
            const merged = new Int16Array(this.pendingPcm.length + pcm16.length);
            merged.set(this.pendingPcm);
            merged.set(pcm16, this.pendingPcm.length);
            combined = merged;
            this.pendingPcm = undefined;
            this.pendingPcmSampleRateHz = undefined;
        }
        // Buffer decoded PCM so Whisper sees contiguous 80–200ms chunks
        let offset = 0;
        let framesEmitted = 0;
        let loggedEmitStats = false;
        while (combined.length - offset >= emitSamples) {
            const slice = combined.subarray(offset, offset + emitSamples);
            const sliceStats = computePcmStats(slice);
            this.healthMonitor.recordEmittedChunk(sliceStats.rms, sliceStats.peak);
            if (!loggedEmitStats) {
                const accumulated = combined.subarray(offset);
                this.maybeLogEmitDebug(accumulated, slice, sampleRateHz, seq);
                loggedEmitStats = true;
            }
            if (this.audioTap && slice.length > 0) {
                const frameBuf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
                this.audioTap.push('EMITTED_BUFFERED', frameBuf);
            }
            offset += emitSamples;
            framesEmitted += 1;
            if (!this.decodedProbeLogged && (0, audioProbe_1.diagnosticsEnabled)()) {
                this.decodedProbeLogged = true;
                const pcmBuffer = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
                const meta = {
                    callId: this.callControlId,
                    format: 'pcm16le',
                    codec: encoding,
                    sampleRateHz: decodeResult.sampleRateHz,
                    channels: 1,
                    bitDepth: 16,
                    logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
                    lineage: ['rx.decoded.pcm16'],
                };
                (0, audioProbe_1.attachAudioMeta)(pcmBuffer, meta);
                (0, audioProbe_1.probePcm)('rx.decoded.pcm16', pcmBuffer, meta);
            }
            if (encoding === 'AMR-WB' && amrwbEmitDebugEnabled()) {
                const now = Date.now();
                if (this.shouldLogAmrwbEmitDebug(now)) {
                    const counts = this.countNearZeroSamples(slice, AMRWB_NEAR_ZERO_THRESHOLD);
                    const zeroRatio = slice.length > 0 ? counts.zero / slice.length : 1;
                    const nearZeroRatio = slice.length > 0 ? counts.nearZero / slice.length : 1;
                    log_1.log.info({
                        event: 'amrwb_emit_debug',
                        call_control_id: this.callControlId,
                        frame_seq: seq ?? this.frameSeq,
                        samples: slice.length,
                        sample_rate_hz: sampleRateHz,
                        rms: Number(sliceStats.rms.toFixed(6)),
                        peak: Number(sliceStats.peak.toFixed(6)),
                        zero_samples: counts.zero,
                        zero_ratio: Number(zeroRatio.toFixed(6)),
                        near_zero_samples: counts.nearZero,
                        near_zero_ratio: Number(nearZeroRatio.toFixed(6)),
                        near_zero_threshold: AMRWB_NEAR_ZERO_THRESHOLD,
                        emit_chunk_ms: this.emitChunkMs,
                        ...(this.logContext ?? {}),
                    }, 'AMR-WB emit debug');
                }
            }
            this.onFrame({
                callControlId: this.callControlId,
                pcm16: slice,
                sampleRateHz,
                channels: 1,
                timestamp,
                seq,
            });
        }
        if (offset < combined.length) {
            const remaining = combined.length - offset;
            const leftover = new Int16Array(remaining);
            leftover.set(combined.subarray(offset));
            this.pendingPcm = leftover;
            this.pendingPcmSampleRateHz = sampleRateHz;
        }
        this.healthMonitor.recordPayload(buffer.length, pcm16.byteLength, rms, peak, decodeOk);
        this.checkHealth(encoding);
        const now = Date.now();
        if (now - this.lastStatsLogAt >= 1000) {
            this.lastStatsLogAt = now;
            const stats = this.healthMonitor.getStats();
            log_1.log.info({
                event: 'media_ingest_decode_stats',
                call_control_id: this.callControlId,
                codec: encoding,
                payload_source: payloadSource ?? null,
                frame_seq: seq ?? this.frameSeq,
                frames_emitted: framesEmitted,
                rms: Number(stats.lastRms.toFixed(6)),
                peak: Number(stats.lastPeak.toFixed(6)),
                decoded_frames: stats.decodedFrames,
                silent_frames: stats.silentFrames,
                emitted_chunks: stats.emittedChunks,
                tiny_payload_frames: stats.tinyPayloadFrames,
                decode_failures: stats.decodeFailures,
                rolling_rms: Number(stats.rollingRms.toFixed(6)),
                rx_frames_inbound: this.rxFramesInbound,
                rx_frames_outbound_skipped: this.rxFramesOutboundSkipped,
                rx_frames_unknown_track_skipped: this.rxFramesUnknownTrackSkipped,
                force_amrwb_be: this.forceAmrWbBe,
                ...(this.logContext ?? {}),
            }, 'media ingest decode stats');
        }
    }
    checkHealth(codec) {
        const now = Date.now();
        const reason = this.healthMonitor.evaluate(now);
        if (!reason || this.ingestUnhealthyLogged)
            return;
        const stats = this.healthMonitor.getStats();
        this.ingestUnhealthyLogged = true;
        try {
            this.audioTap?.flush('IN_DECODED_PCM', `unhealthy_${reason}_decoded`);
            this.audioTap?.flush('EMITTED_BUFFERED', `unhealthy_${reason}_emitted`);
        }
        catch {
            // never allow debug to affect call flow
        }
        log_1.log.warn({
            event: 'media_ingest_unhealthy',
            call_control_id: this.callControlId,
            reason,
            codec,
            total_frames: stats.totalFrames,
            decoded_frames: stats.decodedFrames,
            silent_frames: stats.silentFrames,
            emitted_chunks: stats.emittedChunks,
            tiny_payload_frames: stats.tinyPayloadFrames,
            decode_failures: stats.decodeFailures,
            rolling_rms: Number(stats.rollingRms.toFixed(6)),
            last_rms: Number(stats.lastRms.toFixed(6)),
            last_peak: Number(stats.lastPeak.toFixed(6)),
            ...(this.logContext ?? {}),
        }, 'media ingest unhealthy');
        void this.handleUnhealthy(reason, codec);
    }
    async handleUnhealthy(reason, codec) {
        // AMR-WB payloads are naturally small; never restart stream for "tiny_payloads".
        if (codec === 'AMR-WB' && reason === 'tiny_payloads') {
            this.onReprompt?.(reason);
            return;
        }
        if (reason === 'low_rms') {
            this.onReprompt?.(reason);
            return;
        }
        if (this.transportMode !== 'pstn') {
            this.onReprompt?.(reason);
            return;
        }
        if (this.restartAttempts >= this.maxRestartAttempts) {
            this.onReprompt?.(reason);
            return;
        }
        if (!this.onRestartStreaming) {
            this.onReprompt?.(reason);
            return;
        }
        this.restartAttempts += 1;
        this.healthMonitor.disable();
        log_1.log.warn({
            event: 'media_ingest_restart_streaming',
            call_control_id: this.callControlId,
            attempt: this.restartAttempts,
            reason,
            previous_codec: codec,
            requested_codec: codec,
            ...(this.logContext ?? {}),
        }, 'media ingest restart streaming');
        try {
            const requestedCodec = this.transportMode === 'pstn' && this.allowAmrWb && this.acceptCodecs.has('AMR-WB') ? 'AMR-WB' : codec;
            this.activeStreamId = null;
            this.lastSeqByStream.clear();
            const ok = await this.onRestartStreaming(requestedCodec, reason);
            if (ok && requestedCodec === 'AMR-WB') {
                this.pinnedCodec = 'AMR-WB';
                this.maybeEnableForceBe('AMR-WB', 'payload');
            }
            if (!ok) {
                log_1.log.warn({ event: 'media_ingest_restart_failed', call_control_id: this.callControlId, reason, ...(this.logContext ?? {}) }, 'media ingest restart failed');
                this.onReprompt?.(reason);
            }
        }
        catch (error) {
            log_1.log.warn({
                event: 'media_ingest_restart_failed',
                call_control_id: this.callControlId,
                reason,
                err: error,
                ...(this.logContext ?? {}),
            }, 'media ingest restart failed');
            this.onReprompt?.(reason);
        }
    }
}
exports.MediaIngest = MediaIngest;
//# sourceMappingURL=mediaIngest.js.map