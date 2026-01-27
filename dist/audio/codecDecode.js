"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTelnyxAcceptCodecs = parseTelnyxAcceptCodecs;
exports.shouldUsePcm16Ingest = shouldUsePcm16Ingest;
exports.resamplePcm16 = resamplePcm16;
exports.decodeTelnyxPayloadToPcm16 = decodeTelnyxPayloadToPcm16;
exports.closeTelnyxCodecState = closeTelnyxCodecState;
exports.clearTelnyxCodecSession = clearTelnyxCodecSession;
// src/audio/codecDecode.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const log_1 = require("../log");
const g722_1 = require("./vendor/g722/g722");
const postprocess_1 = require("./postprocess");
const opusDecoder_1 = require("./opusDecoder");
const resample48kTo16k_1 = require("./resample48kTo16k");
const amrwbRtp_1 = require("./amrwbRtp");
const SESSION_STATE_CACHE = new Map();
function getSessionKey(logContext) {
    const id = (typeof logContext?.call_control_id === 'string' && logContext.call_control_id) ||
        (typeof logContext?.sessionId === 'string' && logContext.sessionId) ||
        (typeof logContext?.callId === 'string' && logContext.callId) ||
        null;
    return id ? String(id) : null;
}
function getOrCreateSessionState(provided, logContext) {
    if (provided)
        return provided;
    const key = getSessionKey(logContext);
    if (!key)
        return {};
    const existing = SESSION_STATE_CACHE.get(key);
    if (existing)
        return existing;
    const created = {};
    SESSION_STATE_CACHE.set(key, created);
    // keep cache bounded
    const max = Number.parseInt(process.env.CODEC_STATE_CACHE_MAX ?? '128', 10);
    const maxSessions = Number.isFinite(max) && max > 0 ? max : 128;
    if (SESSION_STATE_CACHE.size > maxSessions) {
        const firstKey = SESSION_STATE_CACHE.keys().next().value;
        if (firstKey)
            SESSION_STATE_CACHE.delete(firstKey);
    }
    return created;
}
/**
 * Accept-Codecs header normalization used upstream.
 */
function parseTelnyxAcceptCodecs(raw) {
    const set = new Set();
    if (!raw)
        return set;
    for (const part of raw.split(',')) {
        const normalized = part.trim().toUpperCase();
        if (!normalized)
            continue;
        set.add(normalized === 'AMRWB' || normalized === 'AMR_WB' ? 'AMR-WB' : normalized);
    }
    return set;
}
/**
 * Should we ingest PCM16 from Telnyx (vs PCMU-only)?
 */
function shouldUsePcm16Ingest(acceptCodecs, allowAmrWb, allowG722, allowOpus) {
    for (const codec of acceptCodecs) {
        if (codec !== 'PCMU')
            return true;
    }
    return allowAmrWb || allowG722 || allowOpus;
}
const DEFAULT_OPUS_SAMPLE_RATE = 48000;
const DEBUG_POST_DECODE_INTERVAL_MS = 1000;
const DEBUG_CHUNK_MIN_MS = 50;
const DEBUG_CHUNK_MAX_MS = 120;
const DEBUG_CHUNK_INTERVAL_MS = 300;
const DEBUG_WINDOW_MS = 400;
const AMRWB_STREAM_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');
const AMRWB_SELECTED_RECENT_DEDUPE_N = Number.parseInt(process.env.AMRWB_SELECTED_RECENT_DEDUPE_N ?? '32', 10);
// Global per-file write serialization (prevents concurrent append races)
const AMRWB_SELECTED_WRITE_BY_PATH = new Map();
// Rolling recent-frame dedupe state per output file path
const AMRWB_SELECTED_RECENT_BY_PATH = new Map();
const AMRWB_FRAME_RATE = 50;
const AMRWB_STREAM_STDERR_MAX_BYTES = 4096;
const AMRWB_DEBUG_MAX_FRAMES = 30;
const AMRWB_DEBUG_MAX_DROPOUTS = 50;
const AMRWB_DEBUG_INTERVAL_MS = 1000;
const AMRWB_MIN_DECODE_FRAMES = Number.parseInt(process.env.AMRWB_MIN_DECODE_FRAMES ?? '10', 10); // ~200ms
const AMRWB_MAX_BUFFER_MS = Number.parseInt(process.env.AMRWB_MAX_BUFFER_MS ?? '500', 10); // safety flush
/* ---------------------------------- utils --------------------------------- */
function normalizeAmrWbPcmLength(pcm16, expectedSamples) {
    if (expectedSamples <= 0)
        return pcm16;
    if (pcm16.length === expectedSamples)
        return pcm16;
    // Trim if too long
    if (pcm16.length > expectedSamples) {
        const extra = pcm16.length - expectedSamples;
        // If extra is leading near-zero, drop it
        let leadZeros = 0;
        const maxCheck = Math.min(extra, pcm16.length);
        while (leadZeros < maxCheck && Math.abs(pcm16[leadZeros] ?? 0) <= 1)
            leadZeros++;
        if (leadZeros === extra)
            return pcm16.subarray(extra);
        return pcm16.subarray(0, expectedSamples);
    }
    // ✅ PAD if too short (this is the real fix for "slow audio")
    const out = new Int16Array(expectedSamples);
    out.set(pcm16, 0);
    // remainder stays 0 (silence)
    return out;
}
function parseBoolEnv(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
function debugPostDecodeEnabled() {
    return (parseBoolEnv(process.env.TELNYX_DEBUG_TAP_POST_DECODE) || parseBoolEnv(process.env.STT_DEBUG_DUMP_POST_DECODE));
}
function debugPcmDumpEnabled() {
    return parseBoolEnv(process.env.STT_DEBUG_DUMP_PCM16);
}
function amrwbDecodeDebugEnabled() {
    return parseBoolEnv(process.env.AMRWB_DECODE_DEBUG);
}
function amrwbStrictDecodeEnabled() {
    return parseBoolEnv(process.env.AMRWB_STRICT_DECODE);
}
function debugDir() {
    return process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== ''
        ? process.env.STT_DEBUG_DIR.trim()
        : '/tmp/veralux-stt-debug';
}
function dedupeConsecutiveFramesForDecode(state, frames) {
    if (!frames || frames.length === 0)
        return { frames, dropped: 0, kept: 0 };
    const out = [];
    let dropped = 0;
    for (const fr of frames) {
        const h = sha1Hex(fr);
        if (state.amrwbLastDecodedStorageFrameSha1 && state.amrwbLastDecodedStorageFrameSha1 === h) {
            dropped += 1;
            continue;
        }
        out.push(fr);
        state.amrwbLastDecodedStorageFrameSha1 = h;
    }
    const kept = out.length;
    state.amrwbDecodeDedupeDropped = (state.amrwbDecodeDedupeDropped ?? 0) + dropped;
    state.amrwbDecodeDedupeKept = (state.amrwbDecodeDedupeKept ?? 0) + kept;
    return { frames: out, dropped, kept };
}
function sha1Hex(buf) {
    return crypto_1.default.createHash('sha1').update(buf).digest('hex');
}
function dedupeKeyForFrame(frame) {
    // include length to avoid collisions across different frame sizes
    return `${frame.length}:${sha1Hex(frame)}`;
}
function getRecentDedupeForPath(outPath) {
    const existing = AMRWB_SELECTED_RECENT_BY_PATH.get(outPath);
    if (existing)
        return existing;
    const created = { seen: new Set(), q: [] };
    AMRWB_SELECTED_RECENT_BY_PATH.set(outPath, created);
    // optional: bound this map so it doesn't grow forever
    if (AMRWB_SELECTED_RECENT_BY_PATH.size > 256) {
        const firstKey = AMRWB_SELECTED_RECENT_BY_PATH.keys().next().value;
        if (firstKey)
            AMRWB_SELECTED_RECENT_BY_PATH.delete(firstKey);
    }
    return created;
}
function hasSeenFrameRecentlyForPath(outPath, key, max) {
    const st = getRecentDedupeForPath(outPath);
    if (st.seen.has(key))
        return true;
    st.seen.add(key);
    st.q.push(key);
    while (st.q.length > max) {
        const old = st.q.shift();
        if (old)
            st.seen.delete(old);
    }
    return false;
}
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
function countZeroSamples(samples) {
    let count = 0;
    for (let i = 0; i < samples.length; i += 1) {
        if (samples[i] === 0)
            count += 1;
    }
    return count;
}
function shouldLogAmrwbDebug(state, now, isDropout) {
    if (!amrwbDecodeDebugEnabled())
        return false;
    const lastLogAt = state.amrwbDebugLastLogAt ?? 0;
    const count = state.amrwbDebugCount ?? 0;
    const dropoutCount = state.amrwbDebugDropoutCount ?? 0;
    if (isDropout && dropoutCount < AMRWB_DEBUG_MAX_DROPOUTS) {
        state.amrwbDebugDropoutCount = dropoutCount + 1;
        state.amrwbDebugLastLogAt = now;
        return true;
    }
    if (count < AMRWB_DEBUG_MAX_FRAMES || now - lastLogAt >= AMRWB_DEBUG_INTERVAL_MS) {
        state.amrwbDebugCount = count + 1;
        state.amrwbDebugLastLogAt = now;
        return true;
    }
    return false;
}
function takeRollingWindowPcm16(state, pcm16, sampleRateHz, windowMs) {
    const winSamples = Math.max(1, Math.round((sampleRateHz * windowMs) / 1000));
    const prev = state.debugRollingPcm16 ?? new Int16Array(0);
    const merged = new Int16Array(prev.length + pcm16.length);
    merged.set(prev, 0);
    merged.set(pcm16, prev.length);
    const start = Math.max(0, merged.length - winSamples);
    const sliced = merged.subarray(start);
    state.debugRollingPcm16 = new Int16Array(sliced);
    if (merged.length < winSamples)
        return null;
    return state.debugRollingPcm16;
}
async function maybeDumpPostDecode(samples, sampleRateHz, encoding, state, logContext) {
    if (!debugPostDecodeEnabled())
        return;
    if (!state)
        return;
    if (!samples || samples.length === 0 || sampleRateHz <= 0)
        return;
    const callId = typeof logContext?.call_control_id === 'string' ? logContext.call_control_id : 'unknown';
    const dir = path_1.default.join(debugDir(), callId);
    try {
        await fs_1.default.promises.mkdir(dir, { recursive: true });
    }
    catch (error) {
        log_1.log.warn({ event: 'stt_post_decode_dump_failed', encoding, file_path: dir, err: error, ...(logContext ?? {}) }, 'stt post-decode dump failed');
        return;
    }
    const now = Date.now();
    /* ----------------------- (A) CHUNK DUMP (>=50ms) ----------------------- */
    const chunkMinSamples = Math.max(1, Math.round((sampleRateHz * DEBUG_CHUNK_MIN_MS) / 1000));
    const chunkMaxSamples = Math.max(chunkMinSamples, Math.round((sampleRateHz * DEBUG_CHUNK_MAX_MS) / 1000));
    const canChunkDump = !state.debugLastChunkDumpMs || now - state.debugLastChunkDumpMs >= DEBUG_CHUNK_INTERVAL_MS;
    if (canChunkDump && samples.length >= chunkMinSamples) {
        state.debugLastChunkDumpMs = now;
        const take = Math.min(samples.length, chunkMaxSamples);
        const chunk = samples.subarray(samples.length - take);
        const chunkStats = computePcmStats(chunk);
        const chunkIndex = (state.debugChunkDumpIndex ?? 0) + 1;
        state.debugChunkDumpIndex = chunkIndex;
        const chunkPath = path_1.default.join(dir, `decoded_pcm_chunk_${String(chunkIndex).padStart(4, '0')}.wav`);
        try {
            const wav = (0, postprocess_1.encodePcm16ToWav)(chunk, sampleRateHz);
            await fs_1.default.promises.writeFile(chunkPath, wav);
            log_1.log.info({
                event: 'stt_post_decode_chunk',
                encoding,
                sample_rate_hz: sampleRateHz,
                samples: chunk.length,
                ms: Number(((chunk.length / sampleRateHz) * 1000).toFixed(2)),
                rms: Number(chunkStats.rms.toFixed(6)),
                peak: Number(chunkStats.peak.toFixed(6)),
                zero_ratio: Number((countZeroSamples(chunk) / chunk.length).toFixed(6)),
                file_path: chunkPath,
                ...(logContext ?? {}),
            }, 'stt post-decode chunk dump');
        }
        catch (error) {
            log_1.log.warn({ event: 'stt_post_decode_chunk_dump_failed', encoding, file_path: chunkPath, err: error, ...(logContext ?? {}) }, 'stt post-decode chunk dump failed');
        }
    }
    /* --------------------- (B) 400ms WINDOW DUMP (best) --------------------- */
    const prevRate = state.debugPcmAccumSampleRateHz;
    if (prevRate && prevRate !== sampleRateHz) {
        state.debugPcmAccum = [];
        state.debugPcmAccumSamples = 0;
        state.debugRollingPcm16 = new Int16Array(0);
    }
    state.debugPcmAccumSampleRateHz = sampleRateHz;
    const window = takeRollingWindowPcm16(state, samples, sampleRateHz, DEBUG_WINDOW_MS);
    if (!window)
        return;
    const winStats = computePcmStats(window);
    const dumpIndex = (state.debugPcmDumpIndex ?? 0) + 1;
    state.debugPcmDumpIndex = dumpIndex;
    const winPath = path_1.default.join(dir, `decoded_pcm_400ms_${String(dumpIndex).padStart(4, '0')}.wav`);
    try {
        const wav = (0, postprocess_1.encodePcm16ToWav)(window, sampleRateHz);
        await fs_1.default.promises.writeFile(winPath, wav);
        log_1.log.info({
            event: 'stt_post_decode_400ms',
            encoding,
            sample_rate_hz: sampleRateHz,
            samples: window.length,
            ms: Number(((window.length / sampleRateHz) * 1000).toFixed(2)),
            rms: Number(winStats.rms.toFixed(6)),
            peak: Number(winStats.peak.toFixed(6)),
            zero_ratio: Number((countZeroSamples(window) / window.length).toFixed(6)),
            file_path: winPath,
            ...(logContext ?? {}),
        }, 'stt post-decode 400ms window dump');
    }
    catch (error) {
        log_1.log.warn({ event: 'stt_post_decode_dump_failed', encoding, file_path: winPath, err: error, ...(logContext ?? {}) }, 'stt post-decode dump failed');
    }
}
async function maybeDumpPcm16(samples, sampleRateHz, encoding, state, logContext) {
    if (!debugPcmDumpEnabled())
        return;
    const now = Date.now();
    if (state?.debugLastPcmDumpMs && now - state.debugLastPcmDumpMs < DEBUG_POST_DECODE_INTERVAL_MS)
        return;
    if (state)
        state.debugLastPcmDumpMs = now;
    const callId = typeof logContext?.call_control_id === 'string' ? logContext.call_control_id : 'unknown';
    const dir = debugDir();
    const filePath = path_1.default.join(dir, `post_decode_${callId}_${now}.pcm`);
    try {
        await fs_1.default.promises.mkdir(dir, { recursive: true });
        const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        await fs_1.default.promises.writeFile(filePath, buffer);
    }
    catch (error) {
        log_1.log.warn({ event: 'stt_post_decode_pcm_failed', encoding, file_path: filePath, err: error, ...(logContext ?? {}) }, 'stt post-decode PCM dump failed');
        return;
    }
    const stats = computePcmStats(samples);
    log_1.log.info({
        event: 'stt_post_decode_pcm',
        encoding,
        sample_rate_hz: sampleRateHz,
        samples: samples.length,
        rms: Number(stats.rms.toFixed(6)),
        peak: Number(stats.peak.toFixed(6)),
        file_path: filePath,
        ...(logContext ?? {}),
    }, 'stt post-decode pcm');
}
function clampInt16(value) {
    if (value > 32767)
        return 32767;
    if (value < -32768)
        return -32768;
    return value | 0;
}
function muLawToPcmSample(uLawByte) {
    const u = (~uLawByte) & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const bias = 0x84;
    let sample = ((mantissa << 3) + bias) << exponent;
    sample -= bias;
    if (sign)
        sample = -sample;
    return clampInt16(sample);
}
function aLawToPcmSample(aLawByte) {
    let a = aLawByte ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    switch (seg) {
        case 0:
            t += 8;
            break;
        case 1:
            t += 0x108;
            break;
        default:
            t += 0x108;
            t <<= seg - 1;
            break;
    }
    return (a & 0x80) ? clampInt16(t) : clampInt16(-t);
}
function decodePcmu(payload) {
    const out = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i += 1)
        out[i] = muLawToPcmSample(payload[i]);
    return out;
}
function decodePcma(payload) {
    const out = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i += 1)
        out[i] = aLawToPcmSample(payload[i]);
    return out;
}
function downmixInterleaved(pcm, channels) {
    if (channels <= 1)
        return pcm;
    const frames = Math.floor(pcm.length / channels);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        const base = i * channels;
        for (let c = 0; c < channels; c += 1)
            sum += pcm[base + c] ?? 0;
        out[i] = clampInt16(Math.round(sum / channels));
    }
    return out;
}
function resamplePcm16(input, inputRate, outputRate) {
    if (inputRate <= 0 || outputRate <= 0 || input.length === 0)
        return input;
    if (inputRate === outputRate)
        return input;
    const outputLength = Math.max(1, Math.round(input.length * (outputRate / inputRate)));
    const output = new Int16Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i += 1) {
        const position = i * ratio;
        const index = Math.floor(position);
        const nextIndex = Math.min(index + 1, input.length - 1);
        const frac = position - index;
        const sample0 = input[index] ?? 0;
        const sample1 = input[nextIndex] ?? sample0;
        output[i] = clampInt16(Math.round(sample0 + (sample1 - sample0) * frac));
    }
    return output;
}
function looksLikeOgg(payload) {
    if (payload.length < 4)
        return false;
    return payload.toString('ascii', 0, 4) === 'OggS';
}
/* ----------------------------- codec normalize ----------------------------- */
function normalizeTelnyxEncoding(raw) {
    const rawValue = (raw ?? '').trim();
    if (!rawValue)
        return { raw: '', normalized: '' };
    let s = rawValue.toUpperCase();
    const semi = s.indexOf(';');
    if (semi !== -1)
        s = s.slice(0, semi);
    if (s.includes('/')) {
        const parts = s.split('/').filter(Boolean);
        s = parts[parts.length - 1] ?? s;
    }
    s = s.replace(/[.\-]/g, '_');
    const aliases = {
        MULAW: 'PCMU',
        ULAW: 'PCMU',
        G711: 'PCMU',
        G711_ULAW: 'PCMU',
        G711U: 'PCMU',
        PCMU: 'PCMU',
        ALAW: 'PCMA',
        G711_ALAW: 'PCMA',
        G711A: 'PCMA',
        PCMA: 'PCMA',
        AMRWB: 'AMR-WB',
        AMR_WB: 'AMR-WB',
        AMR_WB_OA: 'AMR-WB',
        AMR_WB_OCTET_ALIGNED: 'AMR-WB',
        AMR_WB_OCTETALIGNED: 'AMR-WB',
        'AMR-WB': 'AMR-WB',
        G722: 'G722',
        G_722: 'G722',
        OPUS: 'OPUS',
    };
    if (!aliases[s] && s.includes('OPUS'))
        return { raw: rawValue, normalized: 'OPUS' };
    if (!aliases[s] && s.includes('AMR') && s.includes('WB'))
        return { raw: rawValue, normalized: 'AMR-WB' };
    if (!aliases[s] && (s.includes('G722') || s.includes('G_722')))
        return { raw: rawValue, normalized: 'G722' };
    if (!aliases[s] && (s.includes('PCMU') || s.includes('MULAW') || s.includes('ULAW')))
        return { raw: rawValue, normalized: 'PCMU' };
    if (!aliases[s] && (s.includes('PCMA') || s.includes('ALAW')))
        return { raw: rawValue, normalized: 'PCMA' };
    return { raw: rawValue, normalized: aliases[s] ?? s };
}
/* ------------------------------- AMR-WB ---------------------------------- */
/**
 * Supports:
 * 1) RTP octet-aligned payloads: [CMR?][TOC...][speech...]
 * 2) AMR-WB storage frames: [TOC(F=0)+speech...] (optionally preceded by "#!AMR-WB\n")
 *
 * Key behaviors:
 * - transcodeTelnyxAmrWbPayload() is the SINGLE source of truth for Telnyx AMR-WB normalization.
 * - transcoder output is ALWAYS storage frames bytes (NO header). We NEVER re-parse it as octet.
 * - Optional raw octet fallback ONLY when BE is not active and env allows it.
 * - runtime_selected_storage.awb is append-only (no trimming; no rate-limit).
 * - IMPORTANT: Append VALIDATED SPEECH frames immediately when accepted (not only at decode flush),
 *   so the capture is complete even if the call ends before a batch flush.
 * - De-dupe consecutive identical speech frames / appends to prevent "echo/overlap" artifacts.
 * - NEW: Sliding-window frame de-dupe for artifact writes to prevent time-warp/overlap when upstream repeats frames.
 */
const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;
const AMRWB_STREAM_STRICT = parseBoolEnv(process.env.AMRWB_STREAM_STRICT);
const AMRWB_STREAM_DISCARD_CARRYOVER = parseBoolEnv(process.env.AMRWB_STREAM_DISCARD_CARRYOVER ?? 'true');
const AMRWB_STREAM_CARRYOVER_GRACE_BYTES = Number.parseInt(process.env.AMRWB_STREAM_CARRYOVER_GRACE_BYTES ?? '0', 10);
const AMRWB_STREAM_CHUNK_FRAMES = Number.parseInt(process.env.AMRWB_STREAM_CHUNK_FRAMES ?? '20', 10); // ~400ms @ 20ms/frame
const AMRWB_SPEECH_LOST_FT = 14;
const AMRWB_NO_DATA_FT = 15;
function amrWbFrameSize(ft) {
    if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length)
        return AMRWB_FRAME_SIZES[ft] ?? 0;
    if (ft === 9)
        return AMRWB_SID_FRAME_BYTES;
    return 0;
}
function isAmrWbReservedFt(ft) {
    return ft >= 10 && ft <= 13;
}
function ensureAmrWbStreamHeader(buf) {
    if (buf.length >= AMRWB_STREAM_HEADER.length &&
        buf.subarray(0, AMRWB_STREAM_HEADER.length).equals(AMRWB_STREAM_HEADER)) {
        return buf;
    }
    return Buffer.concat([AMRWB_STREAM_HEADER, buf]);
}
function stripAmrWbHeaderIfPresent(buf) {
    if (buf.length >= AMRWB_STREAM_HEADER.length) {
        const head = buf.subarray(0, AMRWB_STREAM_HEADER.length);
        if (head.equals(AMRWB_STREAM_HEADER))
            return buf.subarray(AMRWB_STREAM_HEADER.length);
    }
    return buf;
}
function looksLikeAmrWbStorageFrames(buf) {
    const b = stripAmrWbHeaderIfPresent(buf);
    if (b.length < 1)
        return false;
    const toc0 = b[0];
    const f0 = (toc0 & 0x80) !== 0;
    if (f0)
        return false;
    const ft0 = (toc0 >> 3) & 0x0f;
    if (isAmrWbReservedFt(ft0))
        return false;
    const size0 = amrWbFrameSize(ft0);
    if (ft0 === AMRWB_NO_DATA_FT || ft0 === AMRWB_SPEECH_LOST_FT)
        return true;
    if (size0 <= 0)
        return false;
    if (b.length < 1 + size0)
        return false;
    const nextOff = 1 + size0;
    if (b.length > nextOff) {
        const toc1 = b[nextOff];
        if ((toc1 & 0x80) !== 0)
            return false;
        const ft1 = (toc1 >> 3) & 0x0f;
        if (isAmrWbReservedFt(ft1))
            return false;
    }
    return true;
}
function parseAmrWbStorageToFrames(storageBytes) {
    const payload = stripAmrWbHeaderIfPresent(storageBytes);
    if (payload.length === 0)
        return { ok: false, error: { reason: 'empty_storage' }, cmr: null };
    let offset = 0;
    const frames = [];
    const frameTypes = [];
    let decodedFrames = 0;
    let sidFrames = 0;
    let noDataFrames = 0;
    let speechLostFrames = 0;
    while (offset < payload.length) {
        const tocRaw = payload[offset++];
        // Storage format MUST have follow bit unset.
        const follow = (tocRaw & 0x80) !== 0;
        if (follow) {
            return { ok: false, error: { reason: 'storage_toc_follow_bit_set' }, cmr: null };
        }
        const ft = (tocRaw >> 3) & 0x0f;
        const q = (tocRaw >> 2) & 0x01;
        if (isAmrWbReservedFt(ft)) {
            return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
        }
        // Normalize TOC: F=0, keep only FT+Q, force pad bits to 0.
        const toc = ((ft & 0x0f) << 3) | ((q & 0x01) << 2);
        if (ft === AMRWB_NO_DATA_FT) {
            frames.push(Buffer.from([toc])); // TOC-only
            frameTypes.push('no_data');
            noDataFrames += 1;
            continue;
        }
        if (ft === AMRWB_SPEECH_LOST_FT) {
            frames.push(Buffer.from([toc])); // TOC-only
            frameTypes.push('speech_lost');
            speechLostFrames += 1;
            continue;
        }
        const size = amrWbFrameSize(ft);
        if (size === AMRWB_SID_FRAME_BYTES) {
            if (offset + size > payload.length) {
                return { ok: false, error: { reason: `sid_overflow_ft_${ft}` }, cmr: null };
            }
            const sid = payload.subarray(offset, offset + size);
            offset += size;
            frames.push(Buffer.concat([Buffer.from([toc]), sid]));
            frameTypes.push('sid');
            sidFrames += 1;
            continue;
        }
        if (size <= 0) {
            return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
        }
        if (offset + size > payload.length) {
            return { ok: false, error: { reason: `frame_overflow_ft_${ft}` }, cmr: null };
        }
        const speech = payload.subarray(offset, offset + size);
        offset += size;
        frames.push(Buffer.concat([Buffer.from([toc]), speech]));
        frameTypes.push('speech');
        decodedFrames += 1;
    }
    return {
        ok: true,
        frames,
        frameTypes,
        totalFrames: frameTypes.length,
        decodedFrames,
        sidFrames,
        noDataFrames,
        speechLostFrames,
        cmr: null,
    };
}
function parseAmrWbOctetAlignedToStorageFrames(payload, startOffset) {
    const cmr = startOffset === 1 ? (payload[0] >> 4) & 0x0f : null;
    if (payload.length === 0)
        return { ok: false, error: { reason: 'empty' }, cmr };
    if (startOffset >= payload.length)
        return { ok: false, error: { reason: 'start_offset_out_of_range' }, cmr };
    let offset = startOffset;
    // Parse the TOC list
    const tocEntries = [];
    let follow = true;
    while (follow && offset < payload.length) {
        const toc = payload[offset++];
        follow = (toc & 0x80) !== 0;
        const ft = (toc >> 3) & 0x0f;
        const q = (toc >> 2) & 0x01;
        if (isAmrWbReservedFt(ft)) {
            return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr };
        }
        tocEntries.push({ ft, q });
    }
    if (tocEntries.length === 0)
        return { ok: false, error: { reason: 'missing_toc' }, cmr };
    // Convert TOC entries + speech bytes into STORAGE frames
    const frames = [];
    const frameTypes = [];
    let decodedFrames = 0;
    let sidFrames = 0;
    let noDataFrames = 0;
    let speechLostFrames = 0;
    for (const entry of tocEntries) {
        const ft = entry.ft;
        const q = entry.q;
        const storageToc = ((ft & 0x0f) << 3) | ((q & 0x01) << 2);
        if (ft === AMRWB_NO_DATA_FT) {
            frames.push(Buffer.from([storageToc]));
            frameTypes.push('no_data');
            noDataFrames += 1;
            continue;
        }
        if (ft === AMRWB_SPEECH_LOST_FT) {
            frames.push(Buffer.from([storageToc]));
            frameTypes.push('speech_lost');
            speechLostFrames += 1;
            continue;
        }
        const size = amrWbFrameSize(ft);
        if (size === AMRWB_SID_FRAME_BYTES) {
            if (offset + size > payload.length) {
                return { ok: false, error: { reason: `sid_overflow_ft_${ft}` }, cmr };
            }
            const sid = payload.subarray(offset, offset + size);
            offset += size;
            frames.push(Buffer.concat([Buffer.from([storageToc]), sid]));
            frameTypes.push('sid');
            sidFrames += 1;
            continue;
        }
        if (size <= 0) {
            return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr };
        }
        if (offset + size > payload.length) {
            return { ok: false, error: { reason: `frame_overflow_ft_${ft}` }, cmr };
        }
        const speech = payload.subarray(offset, offset + size);
        offset += size;
        frames.push(Buffer.concat([Buffer.from([storageToc]), speech]));
        frameTypes.push('speech');
        decodedFrames += 1;
    }
    return {
        ok: true,
        frames,
        frameTypes,
        totalFrames: frameTypes.length,
        decodedFrames,
        sidFrames,
        noDataFrames,
        speechLostFrames,
        cmr,
    };
}
function depacketizeAmrWbToStorage(payload, options) {
    const errors = [];
    const skipCmr = options?.skipCmr ?? false;
    if (looksLikeAmrWbStorageFrames(payload)) {
        const parsed = parseAmrWbStorageToFrames(payload);
        if (!parsed.ok)
            return { ok: false, errors: [{ offset: -1, ...parsed.error }] };
        return {
            ok: true,
            storage: Buffer.concat([AMRWB_STREAM_HEADER, ...parsed.frames]),
            frames: parsed.frames,
            frameTypes: parsed.frameTypes,
            totalFrames: parsed.totalFrames,
            mode: 'storage',
            decodedFrames: parsed.decodedFrames,
            sidFrames: parsed.sidFrames,
            noDataFrames: parsed.noDataFrames,
            speechLostFrames: parsed.speechLostFrames,
            hasSpeechFrames: parsed.decodedFrames > 0,
        };
    }
    if (!skipCmr) {
        const withCmr = parseAmrWbOctetAlignedToStorageFrames(payload, 1);
        if (withCmr.ok) {
            return {
                ok: true,
                storage: Buffer.concat([AMRWB_STREAM_HEADER, ...withCmr.frames]),
                frames: withCmr.frames,
                frameTypes: withCmr.frameTypes,
                totalFrames: withCmr.totalFrames,
                mode: 'octet_cmr',
                decodedFrames: withCmr.decodedFrames,
                sidFrames: withCmr.sidFrames,
                noDataFrames: withCmr.noDataFrames,
                speechLostFrames: withCmr.speechLostFrames,
                hasSpeechFrames: withCmr.decodedFrames > 0,
            };
        }
        errors.push({ offset: 1, ...withCmr.error });
    }
    const withoutCmr = parseAmrWbOctetAlignedToStorageFrames(payload, 0);
    if (withoutCmr.ok) {
        return {
            ok: true,
            storage: Buffer.concat([AMRWB_STREAM_HEADER, ...withoutCmr.frames]),
            frames: withoutCmr.frames,
            frameTypes: withoutCmr.frameTypes,
            totalFrames: withoutCmr.totalFrames,
            mode: 'octet_no_cmr',
            decodedFrames: withoutCmr.decodedFrames,
            sidFrames: withoutCmr.sidFrames,
            noDataFrames: withoutCmr.noDataFrames,
            speechLostFrames: withoutCmr.speechLostFrames,
            hasSpeechFrames: withoutCmr.decodedFrames > 0,
        };
    }
    errors.push({ offset: 0, ...withoutCmr.error });
    return { ok: false, errors };
}
/**
 * Append VALIDATED STORAGE SPEECH FRAMES to ONE append-only AMR-WB storage stream per call:
 *   <debugDir>/<callId>/runtime_selected_storage.awb
 *
 * - Serialized per session (promise chain) to prevent interleaved writes.
 * - Writes header once if file is new/empty.
 * - No rate-limit (rate-limit causes incomplete recordings).
 * - Dedupe consecutive identical appends to avoid overlap/echo.
 * - Sliding-window de-dupe across individual frames (prevents overlap/time-warp when upstream repeats frames).
 */
// Drop-in replacement for maybeAppendSelectedStorageFrames() in src/audio/codecDecode.ts
// ✅ Removes FT=2 hardcoding (33B) and seeds recent-window dedupe by parsing frames from disk tail.
// ✅ Keeps: per-path write serialization + lag-1 boundary dedupe + recent-window dedupe.
function maybeAppendSelectedStorageFrames(state, framesNoHeader, logContext) {
    if (!(parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG) || parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB)))
        return;
    if (!framesNoHeader || framesNoHeader.length === 0)
        return;
    const callId = typeof logContext?.call_control_id === 'string' ? String(logContext.call_control_id) : 'unknown';
    const dir = path_1.default.join(debugDir(), callId);
    const outPath = path_1.default.join(dir, 'runtime_selected_storage.awb');
    // --- helpers (local) ---
    const MAX_SPEECH_FRAME_BYTES = 1 + 60; // TOC + max payload (FT=8 => 60 bytes payload)
    function parseStorageSpeechFramesFromPayload(payload) {
        // payload is storage frames bytes (NO "#!AMR-WB\n" header)
        const out = [];
        let off = 0;
        while (off < payload.length) {
            const toc = payload[off];
            if (toc == null)
                break;
            const F = (toc >> 7) & 1;
            const ft = (toc >> 3) & 0x0f;
            // storage format requires F=0
            if (F !== 0)
                break;
            // handle non-speech quickly (we only want speech frames 0..8)
            if (ft === AMRWB_NO_DATA_FT || ft === AMRWB_SPEECH_LOST_FT) {
                // TOC-only frame
                off += 1;
                continue;
            }
            if (ft === 9) {
                // SID: TOC + 5 bytes
                const need = 1 + AMRWB_SID_FRAME_BYTES;
                if (off + need > payload.length)
                    break;
                off += need;
                continue;
            }
            if (isAmrWbReservedFt(ft))
                break;
            const size = amrWbFrameSize(ft);
            if (size <= 0)
                break;
            const need = 1 + size;
            if (off + need > payload.length)
                break;
            const fr = payload.subarray(off, off + need);
            if (ft >= 0 && ft <= 8)
                out.push(Buffer.from(fr)); // copy
            off += need;
        }
        return out;
    }
    function findLikelyStorageFrameBoundary(payload) {
        // Try to find an offset where a valid storage speech frame begins.
        // We accept FT 0..8 speech, F must be 0, and enough bytes must remain.
        const maxScan = Math.min(payload.length, 1024); // keep it cheap
        for (let i = 0; i < maxScan; i += 1) {
            const toc = payload[i];
            if (toc == null)
                break;
            // Storage MUST have F=0
            if ((toc & 0x80) !== 0)
                continue;
            const ft = (toc >> 3) & 0x0f;
            // Skip reserved FTs
            if (isAmrWbReservedFt(ft))
                continue;
            // We only seed on speech frames (0..8)
            if (ft < 0 || ft > 8)
                continue;
            const size = amrWbFrameSize(ft);
            if (size <= 0)
                continue;
            const need = 1 + size;
            if (i + need > payload.length)
                continue;
            // One more sanity check: next TOC (if present) should also have F=0 and not reserved
            const nextOff = i + need;
            if (nextOff < payload.length) {
                const toc2 = payload[nextOff];
                if (toc2 != null) {
                    if ((toc2 & 0x80) !== 0)
                        continue;
                    const ft2 = (toc2 >> 3) & 0x0f;
                    if (isAmrWbReservedFt(ft2))
                        continue;
                    if (ft2 === AMRWB_NO_DATA_FT || ft2 === AMRWB_SPEECH_LOST_FT) {
                        // ok — toc-only frames exist
                    }
                    else if (ft2 === 9) {
                        // ok — SID exists
                    }
                    else if (ft2 < 0 || ft2 > 8) {
                        continue;
                    }
                }
            }
            return i; // ✅ found a plausible boundary
        }
        return 0; // fallback
    }
    async function readTailAndSeedDedupe(fh, fileSize, maxRecent) {
        // Reads a tail chunk, parses storage frames, seeds per-path recent-window dedupe,
        // and returns sha1 of last speech frame parsed (for boundary lag-1 dedupe).
        if (fileSize <= AMRWB_STREAM_HEADER.length)
            return { lastFrameSha1: null, seeded: 0 };
        // Read enough tail bytes to *likely* include last N frames even with smaller frames.
        // Add some slack for safety.
        const want = Math.min(Math.max(0, fileSize - AMRWB_STREAM_HEADER.length), maxRecent * MAX_SPEECH_FRAME_BYTES + 512);
        const startPos = Math.max(AMRWB_STREAM_HEADER.length, fileSize - want);
        const bytesToRead = Math.max(0, fileSize - startPos);
        if (bytesToRead <= 0)
            return { lastFrameSha1: null, seeded: 0 };
        const buf = Buffer.alloc(bytesToRead);
        const r = await fh.read(buf, 0, buf.length, startPos);
        const got = r.bytesRead ?? 0;
        if (got <= 0)
            return { lastFrameSha1: null, seeded: 0 };
        const tailPayload = buf.subarray(0, got); // bytes after header
        const alignedOff = findLikelyStorageFrameBoundary(tailPayload);
        const aligned = alignedOff > 0 ? tailPayload.subarray(alignedOff) : tailPayload;
        const parsed = parseStorageSpeechFramesFromPayload(aligned);
        // Keep only the last maxRecent parsed frames (in case the tail contains more)
        const lastFrames = parsed.length > maxRecent ? parsed.slice(parsed.length - maxRecent) : parsed;
        let seeded = 0;
        for (const fr of lastFrames) {
            const key = dedupeKeyForFrame(fr);
            // NOTE: this mutates the per-path window.
            hasSeenFrameRecentlyForPath(outPath, key, maxRecent);
            seeded += 1;
        }
        const lastFrameSha1 = lastFrames.length > 0 ? sha1Hex(lastFrames[lastFrames.length - 1]) : null;
        return { lastFrameSha1, seeded };
    }
    const doWrite = async () => {
        try {
            await fs_1.default.promises.mkdir(dir, { recursive: true });
            const fh = await fs_1.default.promises.open(outPath, 'a+');
            try {
                const st = await fh.stat();
                // Write header once
                let fileSize = st.size;
                if (fileSize === 0) {
                    await fh.write(AMRWB_STREAM_HEADER, 0, AMRWB_STREAM_HEADER.length, null);
                    fileSize = AMRWB_STREAM_HEADER.length; // ✅ keep accurate for tail seeding
                }
                // Compute window size ONCE
                const maxRecent = Number.isFinite(AMRWB_SELECTED_RECENT_DEDUPE_N) && AMRWB_SELECTED_RECENT_DEDUPE_N > 0
                    ? AMRWB_SELECTED_RECENT_DEDUPE_N
                    : 32;
                // --- Seed boundary + recent-window from disk ---
                let prevSha1 = null;
                try {
                    const seed = await readTailAndSeedDedupe(fh, fileSize, maxRecent);
                    prevSha1 = seed.lastFrameSha1 ?? state.amrwbLastSelectedFrameSha1 ?? null;
                    // ✅ PERSIST the seeded last-frame hash into state
                    if (seed.lastFrameSha1) {
                        state.amrwbLastSelectedFrameSha1 = seed.lastFrameSha1;
                    }
                }
                catch {
                    // If disk-tail parse fails for any reason, fall back to state only.
                    prevSha1 = state.amrwbLastSelectedFrameSha1 ?? null;
                }
                // --- Lag-1 adjacent dedupe (boundary + within batch) ---
                const afterAdj = [];
                let droppedAdjacent = 0;
                for (const fr of framesNoHeader) {
                    if (!fr || fr.length === 0)
                        continue;
                    // Safety: only write valid speech frames
                    if (!isValidAmrWbStorageSpeechFrame(fr))
                        continue;
                    const frSha1 = sha1Hex(fr);
                    if (prevSha1 && frSha1 === prevSha1) {
                        droppedAdjacent += 1;
                        continue;
                    }
                    afterAdj.push(fr);
                    prevSha1 = frSha1;
                }
                if (afterAdj.length === 0) {
                    if (droppedAdjacent > 0) {
                        state.amrwbSelectedDropped = (state.amrwbSelectedDropped ?? 0) + droppedAdjacent;
                        if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
                            log_1.log.info({
                                event: 'AMRWB_RUNTIME_SELECTED_ADJ_DUP_DROPPED',
                                outPath,
                                dropped_adjacent: droppedAdjacent,
                                dropped_total: state.amrwbSelectedDropped ?? 0,
                                ...(logContext ?? {}),
                            }, 'AMR-WB runtime selected storage dropped adjacent duplicates');
                        }
                    }
                    return;
                }
                // --- Recent-window dedupe (kills lag-k replay) ---
                const finalFrames = [];
                let droppedRecent = 0;
                for (const fr of afterAdj) {
                    const key = dedupeKeyForFrame(fr);
                    if (hasSeenFrameRecentlyForPath(outPath, key, maxRecent)) {
                        droppedRecent += 1;
                        continue;
                    }
                    finalFrames.push(fr);
                }
                if (finalFrames.length === 0) {
                    state.amrwbSelectedDropped = (state.amrwbSelectedDropped ?? 0) + droppedAdjacent + droppedRecent;
                    if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
                        log_1.log.info({
                            event: 'AMRWB_RUNTIME_SELECTED_RECENT_DUP_DROPPED_ALL',
                            outPath,
                            dropped_adjacent: droppedAdjacent,
                            dropped_recent: droppedRecent,
                            max_recent: maxRecent,
                            dropped_total: state.amrwbSelectedDropped ?? 0,
                            ...(logContext ?? {}),
                        }, 'AMR-WB runtime selected storage dropped all frames due to recent-window dedupe');
                    }
                    return;
                }
                // Write frames (TOC+payload), no header
                const payloadToWrite = finalFrames.length === 1 ? finalFrames[0] : Buffer.concat(finalFrames);
                await fh.write(payloadToWrite, 0, payloadToWrite.length, null);
                // Update cross-boundary marker to last written frame
                state.amrwbLastSelectedFrameSha1 = sha1Hex(finalFrames[finalFrames.length - 1]);
                // Counters
                state.amrwbSelectedKept = (state.amrwbSelectedKept ?? 0) + finalFrames.length;
                if (droppedAdjacent + droppedRecent > 0) {
                    state.amrwbSelectedDropped = (state.amrwbSelectedDropped ?? 0) + droppedAdjacent + droppedRecent;
                }
                if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
                    const st2 = await fs_1.default.promises.stat(outPath);
                    log_1.log.info({
                        event: 'AMRWB_RUNTIME_SELECTED_APPENDED',
                        outPath,
                        bytes: st2.size,
                        appended_payload_bytes: payloadToWrite.length,
                        appended_frames: finalFrames.length,
                        dropped_adjacent: droppedAdjacent,
                        dropped_recent: droppedRecent,
                        max_recent: maxRecent,
                        dropped_total: state.amrwbSelectedDropped ?? 0,
                        kept_total: state.amrwbSelectedKept ?? 0,
                        ...(logContext ?? {}),
                    }, 'AMR-WB runtime selected storage appended');
                }
            }
            finally {
                await fh.close();
            }
        }
        catch (error) {
            log_1.log.warn({ event: 'amrwb_selected_storage_append_failed', outPath, err: error, ...(logContext ?? {}) }, 'AMR-WB selected storage append failed');
        }
    };
    // Serialize writes per output path to avoid interleaving across concurrent appenders
    const prev = AMRWB_SELECTED_WRITE_BY_PATH.get(outPath) ?? Promise.resolve();
    const next = prev.then(doWrite, doWrite);
    AMRWB_SELECTED_WRITE_BY_PATH.set(outPath, next.catch(() => undefined));
    // Optional: bound the write map so it can’t grow forever
    if (AMRWB_SELECTED_WRITE_BY_PATH.size > 256) {
        const firstKey = AMRWB_SELECTED_WRITE_BY_PATH.keys().next().value;
        if (firstKey)
            AMRWB_SELECTED_WRITE_BY_PATH.delete(firstKey);
    }
}
class AmrWbFfmpegStream {
    constructor() {
        this.stdoutChunks = [];
        this.stdoutLength = 0;
        this.pendingReads = [];
        this.stderrBuffer = Buffer.alloc(0);
        this.closed = false;
        this.headerWritten = false;
        this.decodeCalls = 0;
        const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            // ✅ IMPORTANT: use AMR demuxer (handles AMR-WB header correctly in practice)
            '-f',
            'amr',
            '-i',
            'pipe:0',
            '-f',
            's16le',
            '-ac',
            '1',
            '-ar',
            String(AmrWbFfmpegStream.OUTPUT_RATE_HZ),
            'pipe:1',
        ];
        this.child = (0, child_process_1.spawn)(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
        this.child.stderr.on('data', (chunk) => this.handleStderr(chunk));
        this.child.on('error', (err) => this.handleError(err));
        this.child.on('close', (code, signal) => this.handleClose(code, signal));
    }
    async decode(frames, decodedFrames) {
        if (decodedFrames <= 0 || !frames || frames.length === 0) {
            return new Int16Array(0);
        }
        // Write AMR-WB stream header once
        if (!this.headerWritten) {
            await this.write(AMRWB_STREAM_HEADER);
            this.headerWritten = true;
        }
        // Write the next chunk of storage frames (TOC+payload, no header)
        const payload = frames.length === 1 ? frames[0] : Buffer.concat(frames);
        if (payload.length === 0)
            return new Int16Array(0);
        await this.write(payload);
        const timeoutMs = this.decodeCalls === 0 ? 200 : 80;
        this.decodeCalls += 1;
        // Deterministic: 20ms @ 16k => 320 samples/frame (AMRWB_FRAME_RATE = 50)
        const samplesPerFrame = 320;
        const expectedSamples = decodedFrames * samplesPerFrame;
        const expectedBytes = expectedSamples * 2;
        if (expectedBytes <= 0)
            return new Int16Array(0);
        // Read exactly the amount we expect for this decode call
        const pcmBuf = await this.readExact(expectedBytes, timeoutMs);
        // Safety: if we ever get short reads, the stream is unreliable
        if (pcmBuf.length !== expectedBytes) {
            throw new Error(`ffmpeg stream short read expectedBytes=${expectedBytes} got=${pcmBuf.length} decodedFrames=${decodedFrames}`);
        }
        // CRITICAL: if ffmpeg produced more than expected, it will remain buffered and cause drift on the next call
        const carryBytes = this.stdoutLength; // buffered bytes AFTER our exact read
        if (carryBytes > AMRWB_STREAM_CARRYOVER_GRACE_BYTES) {
            const msg = `ffmpeg stream carryover bytes=${carryBytes} expectedBytes=${expectedBytes} decodedFrames=${decodedFrames}`;
            if (AMRWB_STREAM_STRICT) {
                throw new Error(`${msg} stderr=${this.stderrSnippet()}`);
            }
            if (AMRWB_STREAM_DISCARD_CARRYOVER) {
                // Drain and discard carryover so it can't poison subsequent reads
                this.readFromChunks(carryBytes);
            }
        }
        // Convert to Int16Array (little-endian)
        const pcm = new Int16Array(expectedSamples);
        for (let i = 0, j = 0; i < expectedBytes; i += 2, j += 1) {
            pcm[j] = pcmBuf.readInt16LE(i);
        }
        return pcm;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.child.stdin.end();
        }
        catch {
            // ignore
        }
        try {
            this.child.kill();
        }
        catch {
            // ignore
        }
        this.failPending(new Error('ffmpeg stream closed'));
    }
    stderrSnippet() {
        return this.stderrBuffer.toString('utf8');
    }
    handleStdout(chunk) {
        if (this.closed)
            return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.stdoutChunks.push(buf);
        this.stdoutLength += buf.length;
        this.flushReads();
    }
    handleStderr(chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.stderrBuffer = Buffer.concat([this.stderrBuffer, buf]);
        if (this.stderrBuffer.length > AMRWB_STREAM_STDERR_MAX_BYTES) {
            this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - AMRWB_STREAM_STDERR_MAX_BYTES);
        }
    }
    handleError(err) {
        if (this.closed)
            return;
        this.closed = true;
        this.failPending(err);
    }
    handleClose(code, signal) {
        if (this.closed)
            return;
        this.closed = true;
        const message = `ffmpeg stream closed code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        this.failPending(new Error(message));
    }
    async write(buffer) {
        if (this.closed || !this.child.stdin.writable) {
            throw new Error('ffmpeg stdin closed');
        }
        const ok = this.child.stdin.write(buffer);
        if (ok)
            return;
        await new Promise((resolve, reject) => {
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const cleanup = () => {
                this.child.stdin.off('drain', onDrain);
                this.child.stdin.off('error', onError);
            };
            this.child.stdin.once('drain', onDrain);
            this.child.stdin.once('error', onError);
        });
    }
    readExact(bytes, timeoutMs) {
        if (this.closed) {
            return Promise.reject(new Error('ffmpeg stream closed'));
        }
        if (this.stdoutLength >= bytes) {
            return Promise.resolve(this.readFromChunks(bytes));
        }
        return new Promise((resolve, reject) => {
            const entry = { bytes, resolve, reject };
            if (timeoutMs > 0) {
                entry.timeoutId = setTimeout(() => {
                    this.removePending(entry);
                    reject(new Error('ffmpeg stream read timeout'));
                }, timeoutMs);
            }
            this.pendingReads.push(entry);
        });
    }
    removePending(entry) {
        const index = this.pendingReads.indexOf(entry);
        if (index >= 0)
            this.pendingReads.splice(index, 1);
        if (entry.timeoutId)
            clearTimeout(entry.timeoutId);
    }
    readFromChunks(bytes) {
        const out = Buffer.allocUnsafe(bytes);
        let remaining = bytes;
        let offset = 0;
        while (remaining > 0) {
            const chunk = this.stdoutChunks[0];
            if (!chunk)
                break;
            if (chunk.length <= remaining) {
                chunk.copy(out, offset);
                offset += chunk.length;
                remaining -= chunk.length;
                this.stdoutChunks.shift();
            }
            else {
                chunk.copy(out, offset, 0, remaining);
                this.stdoutChunks[0] = chunk.subarray(remaining);
                offset += remaining;
                remaining = 0;
            }
        }
        this.stdoutLength -= bytes - remaining;
        return remaining === 0 ? out : out.subarray(0, offset);
    }
    flushReads() {
        while (this.pendingReads.length > 0) {
            const next = this.pendingReads[0];
            if (!next || this.stdoutLength < next.bytes)
                return;
            this.pendingReads.shift();
            if (next.timeoutId)
                clearTimeout(next.timeoutId);
            const buf = this.readFromChunks(next.bytes);
            next.resolve(buf);
        }
    }
    failPending(err) {
        while (this.pendingReads.length > 0) {
            const next = this.pendingReads.shift();
            if (!next)
                continue;
            if (next.timeoutId)
                clearTimeout(next.timeoutId);
            next.reject(err);
        }
    }
}
// Always decode AMR-WB stream output at 16k for deterministic accounting
AmrWbFfmpegStream.OUTPUT_RATE_HZ = 16000;
function getAmrWbStream(state) {
    if (!state || state.amrwbFfmpegStreamDisabled)
        return null;
    if (parseBoolEnv(process.env.AMRWB_DISABLE_STREAM))
        return null;
    if (state.amrwbFfmpegStream)
        return state.amrwbFfmpegStream;
    state.amrwbFfmpegStream = new AmrWbFfmpegStream();
    state.amrwbFfmpegStreamRate = 16000; // optional (safe to delete the field later)
    return state.amrwbFfmpegStream;
}
async function decodeAmrWbWithFfmpeg(amrwbStorageBytes, logContext) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    return new Promise((resolve) => {
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            // ✅ IMPORTANT: use AMR demuxer
            '-f',
            'amr',
            '-i',
            'pipe:0',
            '-f',
            's16le',
            '-ac',
            '1',
            '-ar',
            '16000',
            'pipe:1',
        ];
        const child = (0, child_process_1.spawn)(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        child.stdout.on('data', (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        child.stderr.on('data', (d) => err.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        child.on('error', (e) => {
            const msg = e instanceof Error ? e.message : String(e);
            log_1.log.warn({ event: 'amrwb_ffmpeg_spawn_failed', err: msg, ...(logContext ?? {}) }, 'ffmpeg spawn failed');
            resolve(null);
        });
        child.on('close', (code) => {
            const stderr = Buffer.concat(err).toString('utf8');
            if (code !== 0) {
                resolve(null);
                return;
            }
            const buf = Buffer.concat(out);
            if (buf.length < 2) {
                resolve(null);
                return;
            }
            const trimmedLen = buf.length - (buf.length % 2);
            const pcm = new Int16Array(trimmedLen / 2);
            for (let i = 0, j = 0; i < trimmedLen; i += 2, j += 1) {
                pcm[j] = buf.readInt16LE(i);
            }
            resolve({ pcm16: pcm, stderr });
        });
        child.stdin.end(amrwbStorageBytes);
    });
}
function scoreCandidate(c) {
    const speech = c.dep.decodedFrames;
    const total = c.dep.totalFrames;
    const penalty = c.dep.noDataFrames + c.dep.speechLostFrames + c.dep.sidFrames;
    const modeBonus = c.dep.mode === 'storage' ? 2 : 0;
    return speech * 10 + Math.max(0, total - penalty) + modeBonus;
}
function isValidAmrWbStorageSpeechFrame(fr) {
    if (!fr || fr.length < 2)
        return false;
    const toc = fr[0];
    // Storage frames MUST have F=0
    const F = (toc & 0x80) !== 0;
    if (F)
        return false;
    const ft = (toc >> 3) & 0x0f;
    // Speech frames only
    if (ft < 0 || ft > 8)
        return false;
    const expected = 1 + amrWbFrameSize(ft);
    if (expected <= 1)
        return false;
    return fr.length === expected;
}
/* ---------------------------------- main ---------------------------------- */
async function decodeTelnyxPayloadToPcm16(opts) {
    const enc = normalizeTelnyxEncoding(opts.encoding);
    const encoding = enc.normalized;
    const state = getOrCreateSessionState(opts.state, opts.logContext);
    const targetRate = opts.targetSampleRateHz;
    const channels = opts.channels ?? 1;
    if (!state.ingestLogged) {
        state.ingestLogged = true;
        log_1.log.info({
            event: 'stt_codec_probe',
            raw_encoding: enc.raw,
            normalized_encoding: encoding,
            channels,
            reported_sample_rate_hz: opts.reportedSampleRateHz,
            payload_len: opts.payload.length,
            target_sample_rate_hz: targetRate,
            ...(opts.logContext ?? {}),
        }, 'STT codec probe');
    }
    if (encoding === 'PCMU') {
        const pcm = decodePcmu(opts.payload);
        const resampled = resamplePcm16(pcm, 8000, targetRate);
        await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
        await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
        return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
    }
    if (encoding === 'PCMA') {
        const pcm = decodePcma(opts.payload);
        const resampled = resamplePcm16(pcm, 8000, targetRate);
        await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
        await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
        return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
    }
    // AMR-WB
    if (encoding === 'AMR-WB') {
        if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
            log_1.log.info({ event: 'amrwb_code_path_reached', encoding, ...(opts.logContext ?? {}) }, 'AMR-WB decode path reached');
        }
        if (!opts.allowAmrWb)
            return null;
        const candidates = [];
        // 1) Run transcoder FIRST (single source of truth)
        const transcode = (0, amrwbRtp_1.transcodeTelnyxAmrWbPayload)(opts.payload);
        const envDefaultBe = parseBoolEnv(process.env.TELNYX_AMRWB_DEFAULT_BE);
        const forcedBe = opts.forceAmrWbBe === true;
        // BE is "active" if forced, env defaulted, or transcoder explicitly parsed BE
        const beActive = forcedBe || envDefaultBe || (transcode.ok && transcode.packing === 'be');
        // requireBe = hard policy: if true and we cannot parse BE, we reject (NO fallback)
        const requireBe = forcedBe || parseBoolEnv(process.env.AMRWB_REQUIRE_BE);
        // If BE is active, do NOT allow raw octet fallback.
        const octetFallbackAllowed = !beActive && parseBoolEnv(process.env.AMRWB_ALLOW_OCTET_FALLBACK);
        const logPathSelectOnce = (chosenPath) => {
            if (state.amrwbPathSelectedLogged)
                return;
            state.amrwbPathSelectedLogged = true;
            log_1.log.info({
                event: 'amrwb_path_select',
                be_active: beActive,
                forced_be: forcedBe,
                env_default_be: envDefaultBe,
                require_be: requireBe,
                transcode_packing: transcode.ok ? transcode.packing : 'transcode_failed',
                cmr_stripped: transcode.ok ? true : null,
                fallback_allowed: octetFallbackAllowed,
                chosen_path: chosenPath,
                ...(opts.logContext ?? {}),
            }, 'AMR-WB path selected');
        };
        // -------------------- ARTIFACT CAPTURE (optional) --------------------
        // IMPORTANT:
        // - Raw Telnyx payload is NOT guaranteed to be octet-aligned storage (and for BE it is *not*).
        // - Always dump raw bytes; only attempt "storage" artifact when we truly have storage bytes.
        if (parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB) || parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG)) {
            (0, amrwbRtp_1.writeAmrwbArtifacts)('amrwb_raw_payload', opts.payload, {
                // DO NOT claim CMR/octet-aligned here
                hasCmr: false,
                meta: {
                    encoding,
                    payload_len: opts.payload.length,
                    be_active: beActive,
                    require_be: requireBe,
                    forced_be: forcedBe,
                    env_default_be: envDefaultBe,
                    ...(opts.logContext ?? {}),
                },
            });
            if (transcode.ok) {
                // Transcoder output is STORAGE frames bytes; artifact writer should treat it as storage (no CMR).
                (0, amrwbRtp_1.writeAmrwbArtifacts)('amrwb_transcoded_output', transcode.output, {
                    hasCmr: false,
                    meta: {
                        packing: transcode.packing,
                        rtp_stripped: transcode.rtpStripped,
                        toc_count: transcode.tocCount,
                        cmr: transcode.cmr ?? null,
                        cmr_stripped: true,
                        total_bytes_in: transcode.totalBytesIn,
                        total_bytes_out: transcode.totalBytesOut,
                        ...(opts.logContext ?? {}),
                    },
                });
            }
        }
        // -------------------- REQUIRE-BE HARD GATE --------------------
        // Require-BE means: we must be able to parse BE. With the BE-only contract,
        // "ok:true" implies BE succeeded; failure implies not-BE/invalid for our purposes.
        if (requireBe && !transcode.ok) {
            state.amrwbLastError = 'amrwb_require_be_mismatch';
            logPathSelectOnce('be');
            const invalidCount = (state.amrwbDepackInvalidCount ?? 0) + 1;
            state.amrwbDepackInvalidCount = invalidCount;
            if (invalidCount <= 10) {
                const hexPrefix = opts.payload.subarray(0, Math.min(32, opts.payload.length)).toString('hex');
                log_1.log.warn({
                    event: 'amrwb_require_be_mismatch',
                    reason: transcode.error,
                    payload_len: opts.payload.length,
                    first_bytes_hex: hexPrefix,
                    rtp_stripped: transcode.rtpStripped,
                    forced_be: forcedBe,
                    env_default_be: envDefaultBe,
                    require_be: requireBe,
                    be_active: beActive,
                    ...(opts.logContext ?? {}),
                }, 'AMR-WB require-BE is enabled but input did not parse as BE');
            }
            return null;
        }
        // -------------------- TRANSCODE RESULT HANDLING --------------------
        if (!transcode.ok) {
            // Transcode failed (requireBe already handled above)
            const invalidCount = (state.amrwbDepackInvalidCount ?? 0) + 1;
            state.amrwbDepackInvalidCount = invalidCount;
            if (invalidCount <= 10) {
                const hexPrefix = opts.payload.subarray(0, Math.min(32, opts.payload.length)).toString('hex');
                log_1.log.warn({
                    event: 'amrwb_depack_invalid',
                    reason: transcode.error,
                    payload_len: opts.payload.length,
                    first_bytes_hex: hexPrefix,
                    rtp_stripped: transcode.rtpStripped,
                    forced_be: forcedBe,
                    env_default_be: envDefaultBe,
                    require_be: requireBe,
                    be_active: beActive,
                    ...(opts.logContext ?? {}),
                }, `AMRWB_DEPACK invalid reason=${transcode.error} firstBytesHex=${hexPrefix} len=${opts.payload.length}`);
            }
            state.amrwbLastError = 'amrwb_depack_invalid';
            // If BE is active, hard-stop: no octet fallback.
            if (beActive) {
                state.amrwbLastError = 'amrwb_be_transcode_failed';
                logPathSelectOnce('be');
                return null;
            }
            // Otherwise: we may attempt octet fallback later (if enabled).
        }
        else {
            // Transcode succeeded
            if (!state.amrwbDepacketizeLogged) {
                state.amrwbDepacketizeLogged = true;
                log_1.log.info({
                    event: 'amrwb_depack',
                    packing: transcode.packing,
                    rtp_stripped: transcode.rtpStripped,
                    toc_count: transcode.tocCount,
                    cmr_stripped: true,
                    total_bytes_in: transcode.totalBytesIn,
                    total_bytes_out: transcode.totalBytesOut,
                    forced_be: forcedBe,
                    env_default_be: envDefaultBe,
                    require_be: requireBe,
                    be_active: beActive,
                    ...(opts.logContext ?? {}),
                }, `AMRWB_DEPACK packing=${transcode.packing} rtpStripped=${transcode.rtpStripped} tocCount=${transcode.tocCount} totalBytesIn=${transcode.totalBytesIn} totalBytesOut=${transcode.totalBytesOut}`);
            }
            // IMPORTANT: transcoder output is ALWAYS storage frames bytes (NO header).
            // We ONLY parse it as storage. We NEVER treat it as octet.
            const storageBytes = ensureAmrWbStreamHeader(transcode.output);
            const parsedStorage = parseAmrWbStorageToFrames(storageBytes);
            if (parsedStorage.ok) {
                if (parsedStorage.decodedFrames > 0) {
                    const depStorage = {
                        ok: true,
                        storage: storageBytes,
                        frames: parsedStorage.frames,
                        frameTypes: parsedStorage.frameTypes,
                        totalFrames: parsedStorage.totalFrames,
                        mode: 'storage',
                        decodedFrames: parsedStorage.decodedFrames,
                        sidFrames: parsedStorage.sidFrames,
                        noDataFrames: parsedStorage.noDataFrames,
                        speechLostFrames: parsedStorage.speechLostFrames,
                        hasSpeechFrames: true,
                    };
                    candidates.push({
                        label: 'transcoded',
                        dep: depStorage,
                        sourcePayloadLen: transcode.output.length,
                        sourceHexPrefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
                    });
                }
                else if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
                    log_1.log.info({
                        event: 'amrwb_transcoded_no_speech',
                        total_frames: parsedStorage.totalFrames,
                        decoded_frames: parsedStorage.decodedFrames,
                        sid_frames: parsedStorage.sidFrames,
                        no_data_frames: parsedStorage.noDataFrames,
                        speech_lost_frames: parsedStorage.speechLostFrames,
                        ...(opts.logContext ?? {}),
                    }, 'AMR-WB transcoded chunk had no speech; ignored');
                }
            }
            else if (!state.amrwbDepacketizeFailedLogged) {
                state.amrwbDepacketizeFailedLogged = true;
                log_1.log.warn({
                    event: 'amrwb_transcoded_storage_parse_failed',
                    reason: parsedStorage.error.reason,
                    invalid_ft: parsedStorage.error.invalidFt ?? null,
                    payload_len: transcode.output.length,
                    packing: transcode.packing,
                    hex_prefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
                    ...(opts.logContext ?? {}),
                }, 'AMR-WB transcoded output did not parse as storage frames');
            }
            // If BE is active/required and we still got no candidate, hard-stop.
            if (candidates.length === 0 && (beActive || requireBe)) {
                state.amrwbLastError = 'amrwb_be_storage_parse_failed';
                logPathSelectOnce('be');
                return null;
            }
        }
        // -------------------- OPTIONAL RAW OCTET FALLBACK --------------------
        if (octetFallbackAllowed) {
            const rawDep = depacketizeAmrWbToStorage(opts.payload, { skipCmr: false });
            if (rawDep.ok) {
                candidates.push({
                    label: 'raw',
                    dep: rawDep,
                    sourcePayloadLen: opts.payload.length,
                    sourceHexPrefix: opts.payload.subarray(0, Math.min(32, opts.payload.length)).toString('hex'),
                });
            }
        }
        if (candidates.length === 0) {
            logPathSelectOnce(beActive || requireBe ? 'be' : 'octet');
            state.amrwbLastError = state.amrwbLastError ?? 'amrwb_no_candidates';
            return null;
        }
        // Filter broken candidates
        const headerLen = AMRWB_STREAM_HEADER.length;
        const valid = candidates.filter((c) => {
            if (!c.dep.storage || c.dep.storage.length <= headerLen)
                return false;
            if (!c.dep.frames || c.dep.frames.length === 0)
                return false;
            if (c.dep.decodedFrames > 0 && c.dep.hasSpeechFrames !== true)
                return false;
            return true;
        });
        if (valid.length === 0) {
            state.amrwbLastError = 'amrwb_no_valid_candidates';
            return null;
        }
        candidates.length = 0;
        candidates.push(...valid);
        candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
        const transcodedCandidate = candidates.find((candidate) => candidate.label === 'transcoded');
        const chosen = transcodedCandidate ?? candidates[0];
        const dep = chosen.dep;
        const chosenPath = chosen.label === 'raw' ? 'octet' : 'be';
        logPathSelectOnce(chosenPath);
        if (chosen.label === 'raw' && !state.amrwbFallbackLogged) {
            state.amrwbFallbackLogged = true;
            log_1.log.warn({
                event: 'amrwb_fallback_used',
                chosen_mode: dep.mode,
                payload_len: opts.payload.length,
                transcode_packing: transcode.ok ? transcode.packing : 'transcode_failed',
                ...(opts.logContext ?? {}),
            }, 'AMR-WB octet fallback used');
        }
        if (!dep.storage || dep.storage.length <= AMRWB_STREAM_HEADER.length) {
            log_1.log.error({ event: 'AMRWB_CHOSEN_INVALID_STORAGE', storage_len: dep.storage?.length ?? -1, ...(opts.logContext ?? {}) }, 'Chosen AMR-WB candidate had invalid storage');
            return null;
        }
        // ---- DIAG: fingerprint incoming decoded speech frames (no behavior change)
        if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
            const max = Math.min(dep.frames.length, 40);
            // Hash only speech frames (same filter as your buffer loop) so we don't get fooled by SID/NODATA.
            const fp = [];
            for (let i = 0; i < max; i += 1) {
                if (dep.frameTypes[i] !== 'speech')
                    continue;
                const fr = dep.frames[i];
                if (!fr || fr.length < 2)
                    continue;
                const h = sha1Hex(fr).slice(0, 10);
                fp.push(h);
                if (fp.length >= 20)
                    break;
            }
            // Count immediate repeats inside the dep.frames list itself (lag-1)
            let lag1 = 0;
            for (let i = 1; i < fp.length; i += 1) {
                if (fp[i] === fp[i - 1])
                    lag1 += 1;
            }
            log_1.log.info({
                event: 'amrwb_dep_frames_fingerprint',
                dep_mode: dep.mode,
                dep_total_frames: dep.frames.length,
                fingerprint_20: fp,
                lag1_repeats_in_dep: lag1,
                ...(opts.logContext ?? {}),
            }, 'AMR-WB dep.frames fingerprint (speech-only)');
        }
        // -------------------- BUFFER AMR-WB FRAMES --------------------
        if (!state.amrwbFrameBuf)
            state.amrwbFrameBuf = [];
        if (!state.amrwbFrameBufDecodedFrames)
            state.amrwbFrameBufDecodedFrames = 0;
        for (let i = 0; i < dep.frames.length; i += 1) {
            if (dep.frameTypes[i] !== 'speech')
                continue;
            const frame = dep.frames[i];
            if (!frame || frame.length < 2)
                continue;
            if (!isValidAmrWbStorageSpeechFrame(frame)) {
                // Optional: trace once in a while so you can confirm the 0xF1 is being rejected
                if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
                    log_1.log.info({
                        event: 'amrwb_drop_invalid_storage_frame',
                        toc_hex: frame[0]?.toString(16),
                        frame_len: frame.length,
                        frame_hex_prefix: frame.subarray(0, Math.min(8, frame.length)).toString('hex'),
                        ...(opts.logContext ?? {}),
                    }, 'Dropped invalid AMR-WB storage frame before buffering');
                }
                continue;
            }
            // Dedupe consecutive identical speech frames to prevent overlap/echo
            const frSha1 = sha1Hex(frame);
            if (state.amrwbLastAcceptedSpeechSha1 && state.amrwbLastAcceptedSpeechSha1 === frSha1) {
                continue;
            }
            state.amrwbLastAcceptedSpeechSha1 = frSha1;
            state.amrwbFrameBuf.push(frame);
            state.amrwbFrameBufDecodedFrames = (state.amrwbFrameBufDecodedFrames ?? 0) + 1;
        }
        const now = Date.now();
        if ((state.amrwbFrameBufDecodedFrames ?? 0) > 0 && !state.amrwbFrameBufLastFlushMs) {
            state.amrwbFrameBufLastFlushMs = now; // buffer start time
        }
        const bufStart = state.amrwbFrameBufLastFlushMs ?? 0;
        const ageMs = bufStart ? now - bufStart : 0;
        const minFrames = Number.isFinite(AMRWB_MIN_DECODE_FRAMES) && AMRWB_MIN_DECODE_FRAMES > 0 ? AMRWB_MIN_DECODE_FRAMES : 10;
        const maxBufferMs = Number.isFinite(AMRWB_MAX_BUFFER_MS) && AMRWB_MAX_BUFFER_MS > 0 ? AMRWB_MAX_BUFFER_MS : 500;
        const haveEnough = (state.amrwbFrameBufDecodedFrames ?? 0) >= minFrames;
        const tooOld = bufStart !== 0 && ageMs >= maxBufferMs;
        if (!haveEnough && !tooOld) {
            return null;
        }
        // Flush buffer -> decode batch (fixed chunk size)
        const chunkFrames = Number.isFinite(AMRWB_STREAM_CHUNK_FRAMES) && AMRWB_STREAM_CHUNK_FRAMES > 0 ? AMRWB_STREAM_CHUNK_FRAMES : 20;
        const framesToDecodeRaw = state.amrwbFrameBuf.slice(0, chunkFrames);
        const framesToDecodeRawFiltered = framesToDecodeRaw.filter(isValidAmrWbStorageSpeechFrame);
        if (framesToDecodeRawFiltered.length !== framesToDecodeRaw.length && parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
            log_1.log.warn({
                event: 'amrwb_filtered_invalid_frames_pre_decode',
                dropped: framesToDecodeRaw.length - framesToDecodeRawFiltered.length,
                kept: framesToDecodeRawFiltered.length,
                ...(opts.logContext ?? {}),
            }, 'Filtered invalid AMR-WB frames before decode');
        }
        const remaining = state.amrwbFrameBuf.slice(chunkFrames);
        // keep remainder for next flush
        state.amrwbFrameBuf = remaining;
        state.amrwbFrameBufDecodedFrames = remaining.length;
        // buffer-start timestamp must reflect oldest frame still buffered
        const priorStart = state.amrwbFrameBufLastFlushMs ?? 0;
        if (remaining.length === 0) {
            state.amrwbFrameBufLastFlushMs = 0;
        }
        else {
            state.amrwbFrameBufLastFlushMs = priorStart || now;
        }
        if (!framesToDecodeRaw || framesToDecodeRaw.length === 0) {
            return null;
        }
        // HARD-STOP drift: consecutive duplicate storage-frame dedupe BEFORE decode
        const dd = dedupeConsecutiveFramesForDecode(state, framesToDecodeRawFiltered);
        const framesToDecode = dd.frames;
        let decodedFramesToDecode = 0;
        for (const fr of framesToDecode) {
            const ft = (fr[0] >> 3) & 0x0f;
            if (ft >= 0 && ft <= 8)
                decodedFramesToDecode += 1; // AMR-WB speech frames only
        }
        // Append ONLY the frames we are actually decoding (authoritative timeline)
        maybeAppendSelectedStorageFrames(state, framesToDecode, opts.logContext);
        const storageForDecode = Buffer.concat([AMRWB_STREAM_HEADER, ...framesToDecode]);
        // ----------------------------- DECODE (FFMPEG) -----------------------------
        // Speech frame timing is 20ms @ 16k = 320 samples per AMR-WB speech frame
        const expectedSpeechSamplesAt16k = decodedFramesToDecode * 320;
        let decoded = null;
        let usedStream = false;
        const stream = getAmrWbStream(state);
        if (stream) {
            try {
                const pcm16 = await stream.decode(framesToDecode, decodedFramesToDecode);
                if (pcm16.length > 0) {
                    decoded = { pcm16 };
                    usedStream = true;
                    state.amrwbFfmpegUsable = true;
                    state.amrwbLastError = undefined;
                }
            }
            catch (error) {
                state.amrwbFfmpegStreamDisabled = true;
                state.amrwbFfmpegUsable = false;
                state.amrwbLastError = 'amrwb_ffmpeg_stream_failed';
                stream.close();
                state.amrwbFfmpegStream = undefined;
                state.amrwbFfmpegStreamRate = undefined;
                log_1.log.warn({
                    event: 'amrwb_ffmpeg_stream_failed',
                    stderr: stream.stderrSnippet(),
                    err: error,
                    ...(opts.logContext ?? {}),
                }, 'AMR-WB ffmpeg stream decode failed');
            }
        }
        if (!decoded || decoded.pcm16.length === 0) {
            const oneShot = await decodeAmrWbWithFfmpeg(storageForDecode, opts.logContext);
            if (!oneShot || oneShot.pcm16.length === 0) {
                state.amrwbFfmpegUsable = false;
                state.amrwbLastError = 'amrwb_ffmpeg_decode_failed';
                return null;
            }
            decoded = { pcm16: oneShot.pcm16 };
        }
        // --------------------------------------------------------------------------
        // normalize PCM length to prevent slow / fast / robotic audio
        // --------------------------------------------------------------------------
        const decodeRateHz = 16000;
        const decodedRaw16k = decoded.pcm16;
        const decodedRawSamplesAt16k = decodedRaw16k.length;
        const shortRead = decodedRawSamplesAt16k < expectedSpeechSamplesAt16k;
        if (amrwbStrictDecodeEnabled() && shortRead) {
            state.amrwbLastError = 'amrwb_short_pcm';
            return null;
        }
        let decoded16k = normalizeAmrWbPcmLength(decodedRaw16k, expectedSpeechSamplesAt16k);
        let pcmOut = targetRate !== decodeRateHz ? resamplePcm16(decoded16k, decodeRateHz, targetRate) : decoded16k;
        const expectedSpeechSamples = targetRate === 16000 ? expectedSpeechSamplesAt16k : Math.round(expectedSpeechSamplesAt16k * (targetRate / 16000));
        pcmOut = normalizeAmrWbPcmLength(pcmOut, expectedSpeechSamples);
        const actualSamples = pcmOut.length;
        const zeroCount = countZeroSamples(pcmOut);
        const zeroRatio = actualSamples > 0 ? zeroCount / actualSamples : 1;
        const decodedStats = computePcmStats(pcmOut);
        const dropout = shortRead || zeroRatio > 0.9 || decodedStats.rms < 0.001;
        if (shouldLogAmrwbDebug(state, Date.now(), dropout)) {
            const prefixSamples = Array.from(pcmOut.subarray(0, 16));
            const prefixBuf = Buffer.from(pcmOut.buffer, pcmOut.byteOffset, Math.min(32, pcmOut.byteLength));
            log_1.log.info({
                event: 'amrwb_decode_debug',
                decode_source: chosen.label,
                mode: dep.mode,
                decoded_frames: decodedFramesToDecode,
                sample_rate_hz: targetRate,
                expected_speech_samples_at16k: expectedSpeechSamplesAt16k,
                decoded_raw_samples_at16k: decodedRawSamplesAt16k,
                short_read: shortRead,
                expected_speech_samples_out: expectedSpeechSamples,
                samples_out: actualSamples,
                zero_samples: zeroCount,
                zero_ratio: Number(zeroRatio.toFixed(6)),
                rms: Number(decodedStats.rms.toFixed(6)),
                peak: Number(decodedStats.peak.toFixed(6)),
                dropout,
                decode_path: usedStream ? 'ffmpeg_stream' : 'ffmpeg',
                pcm_prefix_samples: prefixSamples,
                pcm_prefix_hex: prefixBuf.toString('hex'),
                ...(opts.logContext ?? {}),
            }, 'AMR-WB decode debug');
        }
        state.amrwbFfmpegUsable = true;
        state.amrwbLastError = undefined;
        await maybeDumpPostDecode(pcmOut, targetRate, encoding, state, opts.logContext);
        await maybeDumpPcm16(pcmOut, targetRate, encoding, state, opts.logContext);
        return {
            pcm16: pcmOut,
            sampleRateHz: targetRate,
            decodedFrames: decodedFramesToDecode,
            decodeFailures: 0,
        };
    }
    // G.722
    if (encoding === 'G722') {
        if (!opts.allowG722)
            return null;
        if (!state.g722)
            state.g722 = new g722_1.G722Decoder(64000, 0);
        const decoded = state.g722.decode(opts.payload);
        const resampled = resamplePcm16(decoded, 16000, targetRate);
        await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
        await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
        return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
    }
    // OPUS
    if (encoding === 'OPUS') {
        if (!opts.allowOpus)
            return null;
        if (looksLikeOgg(opts.payload)) {
            log_1.log.warn({ event: 'opus_container_detected', encoding, length: opts.payload.length, ...(opts.logContext ?? {}) }, 'Opus payload appears to be Ogg; expected raw Opus packets');
            return null;
        }
        if ((!state.opus || state.opusChannels !== channels) && !state.opusFailed) {
            try {
                state.opus = new opusDecoder_1.OpusPacketDecoder(channels);
                state.opusChannels = channels;
            }
            catch (error) {
                state.opusFailed = true;
                log_1.log.warn({ err: error, event: 'opus_decoder_init_failed', ...(opts.logContext ?? {}) }, 'Opus decoder init failed');
                return null;
            }
        }
        if (!state.opus || state.opusFailed)
            return null;
        let pcm = new Int16Array(0);
        try {
            const decoded = state.opus.decode(opts.payload);
            const mono = downmixInterleaved(decoded, channels);
            pcm = new Int16Array(mono);
        }
        catch (error) {
            log_1.log.warn({ err: error, event: 'opus_decode_failed', ...(opts.logContext ?? {}) }, 'Opus decode failed');
            return null;
        }
        const inputRate = DEFAULT_OPUS_SAMPLE_RATE;
        const resampled = inputRate === 48000 && targetRate === 16000 ? (0, resample48kTo16k_1.resample48kTo16k)(pcm) : resamplePcm16(pcm, inputRate, targetRate);
        if (!state.opusLogged) {
            state.opusLogged = true;
            log_1.log.info({
                event: 'opus_decode_success',
                input_bytes: opts.payload.length,
                input_rate_hz: inputRate,
                output_rate_hz: targetRate,
                decoded_samples: pcm.length,
                output_samples: resampled.length,
                ...(opts.logContext ?? {}),
            }, 'Opus packet decoded');
        }
        await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
        await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
        return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
    }
    return null;
}
function closeTelnyxCodecState(state) {
    if (!state?.amrwbFfmpegStream)
        return;
    state.amrwbFfmpegStream.close();
    state.amrwbFfmpegStream = undefined;
    state.amrwbFfmpegStreamRate = undefined;
}
/**
 * Clears the cached session state (when caller did not provide a state object).
 * Call this when a Telnyx call ends, using the same logContext that contains call_control_id.
 */
function clearTelnyxCodecSession(logContext) {
    const key = getSessionKey(logContext);
    if (!key)
        return;
    const st = SESSION_STATE_CACHE.get(key);
    if (st?.amrwbFfmpegStream) {
        st.amrwbFfmpegStream.close();
    }
    SESSION_STATE_CACHE.delete(key);
}
//# sourceMappingURL=codecDecode.js.map