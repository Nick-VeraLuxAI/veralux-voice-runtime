"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAmrwbArtifacts = writeAmrwbArtifacts;
exports.rtpOctetAlignedToAwbStorage = rtpOctetAlignedToAwbStorage;
exports.detectAndStripRtpHeader = detectAndStripRtpHeader;
exports.tryParseAmrWbOctetAligned = tryParseAmrWbOctetAligned;
exports.tryParseAmrWbOctetAlignedNoCmr = tryParseAmrWbOctetAlignedNoCmr;
exports.depacketizeAmrWbBandwidthEfficient = depacketizeAmrWbBandwidthEfficient;
exports.depacketizeAmrWbBandwidthEfficientNoCmr = depacketizeAmrWbBandwidthEfficientNoCmr;
exports.repackToOctetAlignedFromBe = repackToOctetAlignedFromBe;
exports.transcodeTelnyxAmrWbPayload = transcodeTelnyxAmrWbPayload;
// src/media/amrwbrtp.ts
const log_1 = require("../log");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const AMRWB_SPEECH_FRAME_BITS = [132, 177, 253, 285, 317, 365, 397, 461, 477];
const AMRWB_SPEECH_FRAME_BYTES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_BITS = 40;
const AMRWB_SID_BYTES = 5;
// NOTE: 14 = Speech Lost, 15 = No Data. Both carry 0 bytes in octet-aligned form.
const AMRWB_ZERO_LEN_FTS = new Set([14, 15]);
const AMRWB_REPACK_DEBUG_MAX = 30;
const AMRWB_REPACK_DEBUG_INTERVAL_MS = 1000;
let amrwbRepackDebugCount = 0;
let amrwbRepackDebugLastLogAt = 0;
function parseBoolEnv(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
function amrwbRepackDebugEnabled() {
    return parseBoolEnv(process.env.AMRWB_REPACK_DEBUG);
}
function amrwbDebugDir() {
    return process.env.STT_DEBUG_DIR || process.env.AMRWB_DEBUG_DIR || '/tmp/veralux-stt-debug';
}
function safeMkdir(dir) {
    try {
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    }
    catch {
        // ignore
    }
}
function writeAmrwbArtifacts(label, payloadOctetAlignedRtp, opts = { hasCmr: true }) {
    const enabled = parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG) || amrwbRepackDebugEnabled();
    if (!enabled)
        return;
    const dir = amrwbDebugDir();
    safeMkdir(dir);
    const stamp = Date.now();
    const base = `${label}__${stamp}`;
    const rtpPath = node_path_1.default.join(dir, `${base}__rtp_octet.bin`);
    const storagePath = node_path_1.default.join(dir, `${base}__storage.awb`);
    try {
        node_fs_1.default.writeFileSync(rtpPath, payloadOctetAlignedRtp);
        const storage = rtpOctetAlignedToAwbStorage(payloadOctetAlignedRtp, { hasCmr: opts.hasCmr });
        if (storage.ok) {
            node_fs_1.default.writeFileSync(storagePath, storage.awb);
        }
        else {
            log_1.log.warn({ event: 'amrwb_artifact_storage_build_failed', label, error: storage.error, hasCmr: opts.hasCmr, ...(opts.meta ?? {}) }, 'AMR-WB artifact: failed to build storage .awb');
        }
        log_1.log.info({
            event: 'amrwb_artifacts_written',
            label,
            rtp_octet_bin: rtpPath,
            storage_awb: storagePath,
            rtp_len: payloadOctetAlignedRtp.length,
            hasCmr: opts.hasCmr,
            ...(opts.meta ?? {}),
        }, 'AMR-WB artifacts written');
    }
    catch (err) {
        log_1.log.warn({ event: 'amrwb_artifacts_write_failed', label, err: String(err) }, 'AMR-WB artifact write failed');
    }
}
function shouldLogAmrwbRepackDebug(now) {
    if (!amrwbRepackDebugEnabled())
        return false;
    if (amrwbRepackDebugCount < AMRWB_REPACK_DEBUG_MAX) {
        amrwbRepackDebugCount += 1;
        amrwbRepackDebugLastLogAt = now;
        return true;
    }
    if (now - amrwbRepackDebugLastLogAt >= AMRWB_REPACK_DEBUG_INTERVAL_MS) {
        amrwbRepackDebugLastLogAt = now;
        return true;
    }
    return false;
}
function isAmrWbInvalidFt(ft) {
    // Reserved/invalid for AMR-WB per RFC4867: 10..13
    // (14=Speech Lost is valid, 15=No Data is valid)
    return ft >= 10 && ft <= 13;
}
function amrWbSpeechBits(ft) {
    if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BITS.length)
        return AMRWB_SPEECH_FRAME_BITS[ft] ?? null;
    if (ft === 9)
        return AMRWB_SID_BITS;
    if (AMRWB_ZERO_LEN_FTS.has(ft))
        return 0;
    return null;
}
function amrWbSpeechBytes(ft) {
    if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BYTES.length)
        return AMRWB_SPEECH_FRAME_BYTES[ft] ?? null;
    if (ft === 9)
        return AMRWB_SID_BYTES;
    if (AMRWB_ZERO_LEN_FTS.has(ft))
        return 0;
    return null;
}
class BitReader {
    constructor(buffer) {
        this.buffer = buffer;
        this.bitOffset = 0;
    }
    remainingBits() {
        return this.buffer.length * 8 - this.bitOffset;
    }
    readBit() {
        if (this.bitOffset >= this.buffer.length * 8)
            return null;
        const byteIndex = this.bitOffset >> 3;
        const bitIndex = 7 - (this.bitOffset & 7);
        const bit = (this.buffer[byteIndex] >> bitIndex) & 0x01;
        this.bitOffset += 1;
        return bit;
    }
    readBits(count) {
        if (this.remainingBits() < count)
            return null;
        let value = 0;
        for (let i = 0; i < count; i += 1) {
            const bit = this.readBit();
            if (bit === null)
                return null;
            value = (value << 1) | bit;
        }
        return value;
    }
    readBitsToBuffer(bitLen) {
        const byteLen = Math.ceil(bitLen / 8);
        const out = Buffer.alloc(byteLen);
        for (let i = 0; i < bitLen; i += 1) {
            const bit = this.readBit();
            if (bit === null)
                return null;
            if (bit === 1) {
                const byteIndex = Math.floor(i / 8);
                const bitIndex = 7 - (i % 8);
                out[byteIndex] |= 1 << bitIndex;
            }
        }
        return out;
    }
    remainingBitsAreZero() {
        for (let bit = this.bitOffset; bit < this.buffer.length * 8; bit += 1) {
            const byteIndex = bit >> 3;
            const bitIndex = 7 - (bit & 7);
            const value = (this.buffer[byteIndex] >> bitIndex) & 0x01;
            if (value !== 0)
                return false;
        }
        return true;
    }
}
function rtpOctetAlignedToAwbStorage(payload, opts = {}) {
    const hasCmr = opts.hasCmr !== false; // default true
    const parsed = hasCmr ? tryParseAmrWbOctetAligned(payload) : tryParseAmrWbOctetAlignedNoCmr(payload);
    if (!parsed.ok)
        return { ok: false, error: parsed.error };
    // Build .awb stream: "#!AMR-WB\n" + (frameHeaderByte + frameDataBytes)*N
    // frameHeaderByte format (AMR file storage): (FT<<3) | (Q<<2)  with remaining bits = 0
    const header = Buffer.from('#!AMR-WB\n', 'ascii');
    // We need to split the data section into per-frame blobs
    // For hasCmr=true: data starts after 1 (CMR) + tocBytes
    // For hasCmr=false: data starts after tocBytes
    const tocBytes = parsed.tocBytes;
    const dataOffset = (hasCmr ? 1 : 0) + tocBytes;
    let cursor = dataOffset;
    const outParts = [header];
    for (const frame of parsed.frames) {
        const ft = frame.ft & 0x0f;
        const q = frame.q & 0x01;
        const storageFrameHeader = Buffer.from([((ft << 3) & 0x78) | ((q << 2) & 0x04)]);
        outParts.push(storageFrameHeader);
        const size = frame.sizeBytes;
        if (size > 0) {
            if (cursor + size > payload.length)
                return { ok: false, error: 'data_truncated' };
            outParts.push(payload.subarray(cursor, cursor + size));
            cursor += size;
        }
    }
    // cursor should land exactly at end of payload
    if (cursor !== payload.length)
        return { ok: false, error: `data_cursor_mismatch_${cursor}_len_${payload.length}` };
    return { ok: true, awb: Buffer.concat(outParts), frames: parsed.frames.length };
}
function detectAndStripRtpHeader(buf) {
    if (buf.length < 12)
        return { payload: buf, stripped: false };
    const version = buf[0] >> 6;
    if (version !== 2)
        return { payload: buf, stripped: false };
    const hasPadding = (buf[0] & 0x20) !== 0;
    const csrcCount = buf[0] & 0x0f;
    const hasExtension = (buf[0] & 0x10) !== 0;
    let headerLen = 12 + csrcCount * 4;
    if (headerLen > buf.length)
        return { payload: buf, stripped: false };
    if (hasExtension) {
        if (headerLen + 4 > buf.length)
            return { payload: buf, stripped: false };
        const extLenWords = buf.readUInt16BE(headerLen + 2);
        headerLen += 4 + extLenWords * 4;
        if (headerLen > buf.length)
            return { payload: buf, stripped: false };
    }
    if (headerLen >= buf.length)
        return { payload: buf, stripped: false };
    let payloadEnd = buf.length;
    if (hasPadding) {
        const paddingLen = buf[buf.length - 1] ?? 0;
        const maxPadding = buf.length - headerLen;
        if (paddingLen > 0 && paddingLen <= maxPadding) {
            payloadEnd = buf.length - paddingLen;
        }
    }
    if (payloadEnd < headerLen)
        return { payload: buf, stripped: false };
    return { payload: buf.subarray(headerLen, payloadEnd), stripped: true };
}
function tryParseAmrWbOctetAligned(payload) {
    if (payload.length < 2)
        return { ok: false, error: 'payload_too_short' };
    const cmr = (payload[0] >> 4) & 0x0f;
    let offset = 1;
    const frames = [];
    let follow = true;
    while (follow) {
        if (offset >= payload.length)
            return { ok: false, error: 'toc_truncated', cmr };
        const toc = payload[offset++];
        follow = (toc & 0x80) !== 0;
        const ft = (toc >> 3) & 0x0f;
        const q = (toc >> 2) & 0x01;
        if (isAmrWbInvalidFt(ft))
            return { ok: false, error: `invalid_ft_${ft}`, cmr };
        const sizeBytes = amrWbSpeechBytes(ft);
        if (sizeBytes === null)
            return { ok: false, error: `invalid_ft_${ft}`, cmr };
        frames.push({
            ft,
            q,
            sizeBytes,
            isSpeech: ft >= 0 && ft <= 8,
            isSid: ft === 9,
            isNoData: ft === 15, // strictly "No Data"
        });
        if (!follow)
            break;
    }
    if (frames.length === 0)
        return { ok: false, error: 'missing_toc', cmr };
    const dataBytes = payload.length - offset;
    const expectedBytes = frames.reduce((sum, frame) => sum + frame.sizeBytes, 0);
    if (dataBytes !== expectedBytes) {
        return { ok: false, error: `data_len_mismatch_expected_${expectedBytes}_got_${dataBytes}`, cmr };
    }
    return {
        ok: true,
        frames,
        cmr,
        tocBytes: frames.length,
        dataBytes,
    };
}
function tryParseAmrWbOctetAlignedNoCmr(payload) {
    if (payload.length < 1)
        return { ok: false, error: 'payload_too_short' };
    let offset = 0;
    const frames = [];
    let follow = true;
    while (follow) {
        if (offset >= payload.length)
            return { ok: false, error: 'toc_truncated' };
        const toc = payload[offset++];
        follow = (toc & 0x80) !== 0;
        const ft = (toc >> 3) & 0x0f;
        const q = (toc >> 2) & 0x01;
        if (isAmrWbInvalidFt(ft))
            return { ok: false, error: `invalid_ft_${ft}` };
        const sizeBytes = amrWbSpeechBytes(ft);
        if (sizeBytes === null)
            return { ok: false, error: `invalid_ft_${ft}` };
        frames.push({
            ft,
            q,
            sizeBytes,
            isSpeech: ft >= 0 && ft <= 8,
            isSid: ft === 9,
            isNoData: ft === 15, // strictly "No Data"
        });
        if (!follow)
            break;
    }
    if (frames.length === 0)
        return { ok: false, error: 'missing_toc' };
    const dataBytes = payload.length - offset;
    const expectedBytes = frames.reduce((sum, frame) => sum + frame.sizeBytes, 0);
    if (dataBytes !== expectedBytes) {
        return { ok: false, error: `data_len_mismatch_expected_${expectedBytes}_got_${dataBytes}` };
    }
    return {
        ok: true,
        frames,
        tocBytes: frames.length,
        dataBytes,
    };
}
function depacketizeAmrWbBandwidthEfficient(payload) {
    if (payload.length === 0)
        return { ok: false, error: 'payload_too_short' };
    const reader = new BitReader(payload);
    const cmr = reader.readBits(4);
    if (cmr === null)
        return { ok: false, error: 'cmr_truncated' };
    const tocEntries = [];
    let follow = 1;
    while (follow === 1) {
        const fBit = reader.readBits(1);
        const ft = reader.readBits(4);
        const q = reader.readBits(1);
        if (fBit === null || ft === null || q === null)
            return { ok: false, error: 'toc_truncated', cmr };
        if (isAmrWbInvalidFt(ft))
            return { ok: false, error: `invalid_ft_${ft}`, cmr };
        tocEntries.push({ ft, q, follow: fBit });
        follow = fBit;
    }
    if (tocEntries.length === 0)
        return { ok: false, error: 'missing_toc', cmr };
    const frames = [];
    for (const entry of tocEntries) {
        const bitLen = amrWbSpeechBits(entry.ft);
        if (bitLen === null)
            return { ok: false, error: `invalid_ft_${entry.ft}`, cmr };
        let data = Buffer.alloc(0);
        if (bitLen > 0) {
            const bits = reader.readBitsToBuffer(bitLen);
            if (!bits)
                return { ok: false, error: `frame_truncated_ft_${entry.ft}`, cmr };
            data = bits;
        }
        frames.push({
            ft: entry.ft,
            q: entry.q,
            bitLen,
            data,
            isSpeech: entry.ft >= 0 && entry.ft <= 8,
            isSid: entry.ft === 9,
            isNoData: entry.ft === 15,
        });
    }
    if (reader.remainingBits() > 0 && !reader.remainingBitsAreZero()) {
        return { ok: false, error: 'trailing_bits_nonzero', cmr };
    }
    return { ok: true, frames, cmr, tocCount: tocEntries.length };
}
function depacketizeAmrWbBandwidthEfficientNoCmr(payload, opts = {}) {
    if (payload.length === 0)
        return { ok: false, error: 'payload_too_short' };
    const reader = new BitReader(payload);
    // If there is no CMR field, use "no preference" (15) by default.
    let cmr = 15;
    if (opts.hasCmr) {
        const cmrBits = reader.readBits(4);
        if (cmrBits === null)
            return { ok: false, error: 'cmr_truncated' };
        cmr = cmrBits;
    }
    const tocEntries = [];
    let follow = 1;
    while (follow === 1) {
        const fBit = reader.readBits(1);
        const ft = reader.readBits(4);
        const q = reader.readBits(1);
        if (fBit === null || ft === null || q === null)
            return { ok: false, error: 'toc_truncated', cmr };
        if (isAmrWbInvalidFt(ft))
            return { ok: false, error: `invalid_ft_${ft}`, cmr };
        tocEntries.push({ ft, q, follow: fBit });
        follow = fBit;
    }
    if (tocEntries.length === 0)
        return { ok: false, error: 'missing_toc', cmr };
    const frames = [];
    for (const entry of tocEntries) {
        const bitLen = amrWbSpeechBits(entry.ft);
        if (bitLen === null)
            return { ok: false, error: `invalid_ft_${entry.ft}`, cmr };
        let data = Buffer.alloc(0);
        if (bitLen > 0) {
            const bits = reader.readBitsToBuffer(bitLen);
            if (!bits)
                return { ok: false, error: `frame_truncated_ft_${entry.ft}`, cmr };
            data = bits;
        }
        frames.push({
            ft: entry.ft,
            q: entry.q,
            bitLen,
            data,
            isSpeech: entry.ft >= 0 && entry.ft <= 8,
            isSid: entry.ft === 9,
            isNoData: entry.ft === 15,
        });
    }
    if (reader.remainingBits() > 0 && !reader.remainingBitsAreZero()) {
        return { ok: false, error: 'trailing_bits_nonzero', cmr };
    }
    return { ok: true, frames, cmr, tocCount: tocEntries.length };
}
function repackToOctetAlignedFromBe(beResult, opts = {}) {
    const includeCmr = opts.includeCmr !== false; // default true
    const cmrByte = ((beResult.cmr ?? 15) & 0x0f) << 4;
    const toc = Buffer.alloc(beResult.frames.length);
    for (let i = 0; i < beResult.frames.length; i += 1) {
        const frame = beResult.frames[i];
        const follow = i < beResult.frames.length - 1 ? 1 : 0;
        toc[i] = (follow << 7) | ((frame.ft & 0x0f) << 3) | ((frame.q & 0x01) << 2);
    }
    const dataParts = beResult.frames.filter((frame) => frame.data.length > 0).map((frame) => frame.data);
    if (!includeCmr)
        return Buffer.concat([toc, ...dataParts]);
    return Buffer.concat([Buffer.from([cmrByte]), toc, ...dataParts]);
}
function verifyRepacked(output, opts) {
    const verify = opts.includeCmr ? tryParseAmrWbOctetAligned(output) : tryParseAmrWbOctetAlignedNoCmr(output);
    if (!verify.ok)
        return { ok: false, error: verify.error };
    return { ok: true, tocCount: verify.frames.length, cmr: verify.cmr };
}
/**
 * Telnyx AMR-WB notes:
 * - Telnyx can send AMR-WB in *bandwidth-efficient* (bit-packed) or *octet-aligned* form.
 * - This function must NEVER "guess-and-strip" a leading byte unless we have *fully validated*
 *   the layout by parsing end-to-end. A prior version could false-positive on BE payloads and
 *   corrupt the stream (robotic/crunchy audio).
 *
 * Output contract:
 * - If octet-aligned parses cleanly -> return payload untouched (do NOT strip CMR).
 * - Else if BE parses cleanly -> repack to octet-aligned (CMR + TOC bytes + padded frame bytes),
 *   or TOC-first if AMRWB_REPACK_INCLUDE_CMR=false, and verify using the matching parser.
 * - Else -> invalid.
 */
function transcodeTelnyxAmrWbPayload(input) {
    const stripped = detectAndStripRtpHeader(input);
    const payload = stripped.payload;
    const now = Date.now();
    // Global knob for repack output layout:
    // - default true: emit CMR byte then TOC then data (classic octet-aligned-with-CMR)
    // - false: emit TOC then data (octet-aligned-no-CMR layout)
    const includeCmr = process.env.AMRWB_REPACK_INCLUDE_CMR !== 'false';
    /**
     * OPTION A (Normalization First):
     * If BE depacketization succeeds (with/without CMR), we ALWAYS normalize through BE->octet,
     * even if octet parsing would also succeed, because octet parsing can be a false-positive
     * on bit-packed payloads and produce robotic/crunchy audio.
     */
    // --- 0) Try Bandwidth-Efficient (bit-packed) first ---
    const be = depacketizeAmrWbBandwidthEfficient(payload);
    if (be.ok) {
        const output = repackToOctetAlignedFromBe(be, { includeCmr });
        const verify = verifyRepacked(output, { includeCmr });
        if (verify.ok) {
            if (shouldLogAmrwbRepackDebug(now)) {
                log_1.log.info({
                    event: 'amrwb_repack_path',
                    path: 'be_normalized_first',
                    payload_len: payload.length,
                    rtp_stripped: stripped.stripped,
                    toc_count: be.frames.length,
                    cmr: be.cmr ?? null,
                    repacked_len: output.length,
                    include_cmr: includeCmr,
                }, 'AMR-WB repack path selected');
            }
            return {
                ok: true,
                packing: 'be',
                rtpStripped: stripped.stripped,
                output,
                tocCount: verify.tocCount,
                totalBytesIn: input.length,
                totalBytesOut: output.length,
                cmr: be.cmr ?? undefined,
                cmrStripped: !includeCmr,
            };
        }
        if (shouldLogAmrwbRepackDebug(now)) {
            log_1.log.info({
                event: 'amrwb_repack_path',
                path: 'be_normalized_first_verify_failed',
                payload_len: payload.length,
                rtp_stripped: stripped.stripped,
                toc_count: be.frames.length,
                cmr: be.cmr ?? null,
                repacked_len: output.length,
                include_cmr: includeCmr,
                verify_error: verify.error,
            }, 'AMR-WB repack verify failed');
        }
        // fall through to try other modes
    }
    const beNoCmr = depacketizeAmrWbBandwidthEfficientNoCmr(payload, { hasCmr: false });
    if (beNoCmr.ok) {
        const output = repackToOctetAlignedFromBe(beNoCmr, { includeCmr });
        const verify = verifyRepacked(output, { includeCmr });
        if (verify.ok) {
            if (shouldLogAmrwbRepackDebug(now)) {
                log_1.log.info({
                    event: 'amrwb_repack_path',
                    path: 'be_no_cmr_normalized_first',
                    payload_len: payload.length,
                    rtp_stripped: stripped.stripped,
                    toc_count: beNoCmr.frames.length,
                    cmr: beNoCmr.cmr ?? null,
                    repacked_len: output.length,
                    include_cmr: includeCmr,
                }, 'AMR-WB repack path selected');
            }
            return {
                ok: true,
                packing: 'be',
                rtpStripped: stripped.stripped,
                output,
                tocCount: verify.tocCount,
                totalBytesIn: input.length,
                totalBytesOut: output.length,
                cmr: beNoCmr.cmr ?? undefined,
                cmrStripped: !includeCmr,
            };
        }
        if (shouldLogAmrwbRepackDebug(now)) {
            log_1.log.info({
                event: 'amrwb_repack_path',
                path: 'be_no_cmr_normalized_first_verify_failed',
                payload_len: payload.length,
                rtp_stripped: stripped.stripped,
                toc_count: beNoCmr.frames.length,
                cmr: beNoCmr.cmr ?? null,
                repacked_len: output.length,
                include_cmr: includeCmr,
                verify_error: verify.error,
            }, 'AMR-WB repack verify failed');
        }
        // fall through
    }
    const beAltHasCmr = depacketizeAmrWbBandwidthEfficientNoCmr(payload, { hasCmr: true });
    if (beAltHasCmr.ok) {
        const output = repackToOctetAlignedFromBe(beAltHasCmr, { includeCmr });
        const verify = verifyRepacked(output, { includeCmr });
        if (verify.ok) {
            if (shouldLogAmrwbRepackDebug(now)) {
                log_1.log.info({
                    event: 'amrwb_repack_path',
                    path: 'be_alt_has_cmr_normalized_first',
                    payload_len: payload.length,
                    rtp_stripped: stripped.stripped,
                    toc_count: beAltHasCmr.frames.length,
                    cmr: beAltHasCmr.cmr ?? null,
                    repacked_len: output.length,
                    include_cmr: includeCmr,
                }, 'AMR-WB repack path selected');
            }
            return {
                ok: true,
                packing: 'be',
                rtpStripped: stripped.stripped,
                output,
                tocCount: verify.tocCount,
                totalBytesIn: input.length,
                totalBytesOut: output.length,
                cmr: beAltHasCmr.cmr ?? undefined,
                cmrStripped: !includeCmr,
            };
        }
        if (shouldLogAmrwbRepackDebug(now)) {
            log_1.log.info({
                event: 'amrwb_repack_path',
                path: 'be_alt_has_cmr_normalized_first_verify_failed',
                payload_len: payload.length,
                rtp_stripped: stripped.stripped,
                toc_count: beAltHasCmr.frames.length,
                cmr: beAltHasCmr.cmr ?? null,
                repacked_len: output.length,
                include_cmr: includeCmr,
                verify_error: verify.error,
            }, 'AMR-WB repack verify failed');
        }
        // fall through
    }
    // --- 1) Strict octet-aligned with CMR ---
    const octet = tryParseAmrWbOctetAligned(payload);
    if (octet.ok) {
        if (shouldLogAmrwbRepackDebug(now)) {
            log_1.log.info({
                event: 'amrwb_repack_path',
                path: 'octet_aligned_with_cmr',
                payload_len: payload.length,
                rtp_stripped: stripped.stripped,
                toc_count: octet.frames.length,
                cmr: octet.cmr ?? null,
                expected_data_bytes: octet.frames.reduce((s, f) => s + f.sizeBytes, 0),
                data_bytes: octet.dataBytes,
            }, 'AMR-WB repack path selected');
        }
        return {
            ok: true,
            packing: 'octet',
            rtpStripped: stripped.stripped,
            output: payload,
            tocCount: octet.frames.length,
            totalBytesIn: input.length,
            totalBytesOut: payload.length,
            cmr: octet.cmr ?? undefined,
            cmrStripped: false,
        };
    }
    // --- 2) Strict octet-aligned without CMR ---
    const octetNoCmr2 = tryParseAmrWbOctetAlignedNoCmr(payload);
    if (octetNoCmr2.ok) {
        if (shouldLogAmrwbRepackDebug(now)) {
            log_1.log.info({
                event: 'amrwb_repack_path',
                path: 'octet_aligned_no_cmr',
                payload_len: payload.length,
                rtp_stripped: stripped.stripped,
                toc_count: octetNoCmr2.frames.length,
                expected_data_bytes: octetNoCmr2.frames.reduce((s, f) => s + f.sizeBytes, 0),
                data_bytes: octetNoCmr2.dataBytes,
            }, 'AMR-WB repack path selected');
        }
        return {
            ok: true,
            packing: 'octet',
            rtpStripped: stripped.stripped,
            output: payload,
            tocCount: octetNoCmr2.frames.length,
            totalBytesIn: input.length,
            totalBytesOut: payload.length,
            cmrStripped: true,
            cmr: undefined,
        };
    }
    // Invalid
    const error = `be:${be.ok ? 'ok_but_verify_failed' : be.error};beNoCmr:${beNoCmr.ok ? 'ok_but_verify_failed' : beNoCmr.error};beAlt:${beAltHasCmr.ok ? 'ok_but_verify_failed' : beAltHasCmr.error};octet:${octet.error};octetNoCmr:${octetNoCmr2.error}`;
    if (shouldLogAmrwbRepackDebug(now)) {
        log_1.log.info({
            event: 'amrwb_repack_path',
            path: 'invalid',
            payload_len: payload.length,
            rtp_stripped: stripped.stripped,
            error,
        }, 'AMR-WB repack path selected');
    }
    return {
        ok: false,
        packing: 'invalid',
        rtpStripped: stripped.stripped,
        error,
        totalBytesIn: input.length,
    };
}
//# sourceMappingURL=amrwbRtp.js.map