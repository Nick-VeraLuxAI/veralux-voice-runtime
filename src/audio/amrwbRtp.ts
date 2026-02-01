// src/media/amrwbRtp.ts
import { log } from '../log';
import fs from 'node:fs';
import path from 'node:path';

type RtpStripResult = { payload: Buffer; stripped: boolean };

export type AmrWbFrameMeta = {
  ft: number;
  q: number;
  sizeBytes: number;
  isSpeech: boolean;
  isSid: boolean;
  isNoData: boolean;
};

export type AmrWbFrameBitsMeta = {
  ft: number;
  q: number;
  bitLen: number;
  data: Buffer;
  isSpeech: boolean;
  isSid: boolean;
  isNoData: boolean;
};

export type OctetAlignedParseResult =
  | {
      ok: true;
      frames: AmrWbFrameMeta[];
      cmr?: number;
      tocBytes: number;
      dataBytes: number;
    }
  | {
      ok: false;
      error: string;
      cmr?: number;
    };

export type BeDepacketizeResult =
  | {
      ok: true;
      frames: AmrWbFrameBitsMeta[];
      cmr: number;
      tocCount: number;
    }
  | {
      ok: false;
      error: string;
      cmr?: number;
    };

export type TranscodeAmrWbResult =
  | {
      ok: true;
      /**
       * packing indicates what we detected on input.
       * output is ALWAYS AMR-WB "storage frames bytes" (no "#!AMR-WB\n" header).
       */
      packing: 'be';
      rtpStripped: boolean;
      output: Buffer;
      tocCount: number;
      totalBytesIn: number;
      totalBytesOut: number;
      /**
       * IMPORTANT SEMANTICS:
       * - cmrStripped=true means: "no CMR byte is present in output" (storage frames start at byte 0)
       *   (This module ALWAYS outputs storage frames, so cmrStripped is always true.)
       */
      cmrStripped: true;
      cmr?: number;
    }
  | {
      ok: false;
      packing: 'invalid';
      rtpStripped: boolean;
      error: string;
      totalBytesIn: number;
    };

const AMRWB_SPEECH_FRAME_BITS = [132, 177, 253, 285, 317, 365, 397, 461, 477];
const AMRWB_SPEECH_FRAME_BYTES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_BITS = 40;
const AMRWB_SID_BYTES = 5;

// NOTE: 14 = Speech Lost, 15 = No Data. Both carry 0 bytes in octet-aligned form.
const AMRWB_ZERO_LEN_FTS = new Set([14, 15]);

const AMRWB_STREAM_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');

const AMRWB_REPACK_DEBUG_MAX = 30;
const AMRWB_REPACK_DEBUG_INTERVAL_MS = 1000;

let amrwbRepackDebugCount = 0;
let amrwbRepackDebugLastLogAt = 0;

/* ---------------------------------- utils --------------------------------- */

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function amrwbRepackDebugEnabled(): boolean {
  return parseBoolEnv(process.env.AMRWB_REPACK_DEBUG);
}

function amrwbDebugDir(): string {
  return process.env.STT_DEBUG_DIR || process.env.AMRWB_DEBUG_DIR || '/tmp/veralux-stt-debug';
}

function safeMkdir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function shouldLogAmrwbRepackDebug(now: number): boolean {
  if (!amrwbRepackDebugEnabled()) return false;
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

/* ----------------------------- RTP strip helper ---------------------------- */

export function detectAndStripRtpHeader(buf: Buffer): RtpStripResult {
  if (buf.length < 12) return { payload: buf, stripped: false };
  const version = buf[0] >> 6;
  if (version !== 2) return { payload: buf, stripped: false };

  const hasPadding = (buf[0] & 0x20) !== 0;
  const csrcCount = buf[0] & 0x0f;
  const hasExtension = (buf[0] & 0x10) !== 0;

  let headerLen = 12 + csrcCount * 4;
  if (headerLen > buf.length) return { payload: buf, stripped: false };

  if (hasExtension) {
    if (headerLen + 4 > buf.length) return { payload: buf, stripped: false };
    const extLenWords = buf.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLenWords * 4;
    if (headerLen > buf.length) return { payload: buf, stripped: false };
  }

  if (headerLen >= buf.length) return { payload: buf, stripped: false };

  let payloadEnd = buf.length;
  if (hasPadding) {
    const paddingLen = buf[buf.length - 1] ?? 0;
    const maxPadding = buf.length - headerLen;
    if (paddingLen > 0 && paddingLen <= maxPadding) {
      payloadEnd = buf.length - paddingLen;
    }
  }

  if (payloadEnd < headerLen) return { payload: buf, stripped: false };
  return { payload: buf.subarray(headerLen, payloadEnd), stripped: true };
}

/* ------------------------------ AMR-WB tables ------------------------------ */

function isAmrWbInvalidFt(ft: number): boolean {
  // Reserved/invalid for AMR-WB per RFC4867: 10..13
  // (14=Speech Lost is valid, 15=No Data is valid)
  return ft >= 10 && ft <= 13;
}

function amrWbSpeechBits(ft: number): number | null {
  if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BITS.length) return AMRWB_SPEECH_FRAME_BITS[ft] ?? null;
  if (ft === 9) return AMRWB_SID_BITS;
  if (AMRWB_ZERO_LEN_FTS.has(ft)) return 0;
  return null;
}

function amrWbSpeechBytes(ft: number): number | null {
  if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BYTES.length) return AMRWB_SPEECH_FRAME_BYTES[ft] ?? null;
  if (ft === 9) return AMRWB_SID_BYTES;
  if (AMRWB_ZERO_LEN_FTS.has(ft)) return 0;
  return null;
}

type AmrWbStorageValidationStats = {
  badF: number;
  badFt: number;
  badLength: number;
};

type AmrWbStorageValidationResult = {
  frames: Buffer[];
  stats: AmrWbStorageValidationStats;
};

function initAmrWbStorageValidationStats(): AmrWbStorageValidationStats {
  return { badF: 0, badFt: 0, badLength: 0 };
}

function totalInvalidAmrWbStorageFrames(stats: AmrWbStorageValidationStats): number {
  return stats.badF + stats.badFt + stats.badLength;
}

function expectedAmrWbStorageFrameLength(ft: number): number | null {
  if (isAmrWbInvalidFt(ft)) return null;
  const bytes = amrWbSpeechBytes(ft);
  if (bytes === null) return null;
  return 1 + bytes;
}

function validateAmrWbStorageFramesBytes(payload: Buffer): AmrWbStorageValidationResult {
  const stats = initAmrWbStorageValidationStats();
  const frames: Buffer[] = [];

  let offset = 0;
  while (offset < payload.length) {
    const toc = payload[offset];
    if (toc == null) break;

    const f = (toc & 0x80) !== 0;
    if (f) {
      stats.badF += 1;
      offset += 1;
      continue;
    }

    const ft = (toc >> 3) & 0x0f;
    const expectedLen = expectedAmrWbStorageFrameLength(ft);
    if (expectedLen === null) {
      stats.badFt += 1;
      offset += 1;
      continue;
    }

    if (offset + expectedLen > payload.length) {
      stats.badLength += 1;
      break;
    }

    const fr = payload.subarray(offset, offset + expectedLen);
    frames.push(Buffer.from(fr));
    offset += expectedLen;
  }

  return { frames, stats };
}

/* -------------------------------- BitReader -------------------------------- */

class BitReader {
  private bitOffset = 0;

  constructor(private readonly buffer: Buffer) {}

  remainingBits(): number {
    return this.buffer.length * 8 - this.bitOffset;
  }

  readBit(): number | null {
    if (this.bitOffset >= this.buffer.length * 8) return null;
    const byteIndex = this.bitOffset >> 3;
    const bitIndex = 7 - (this.bitOffset & 7);
    const bit = (this.buffer[byteIndex] >> bitIndex) & 0x01;
    this.bitOffset += 1;
    return bit;
  }

  readBits(count: number): number | null {
    if (this.remainingBits() < count) return null;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const bit = this.readBit();
      if (bit === null) return null;
      value = (value << 1) | bit;
    }
    return value;
  }

  readBitsToBuffer(bitLen: number): Buffer | null {
    const byteLen = Math.ceil(bitLen / 8);
    const out = Buffer.alloc(byteLen);
    for (let i = 0; i < bitLen; i += 1) {
      const bit = this.readBit();
      if (bit === null) return null;
      if (bit === 1) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8);
        out[byteIndex] |= 1 << bitIndex;
      }
    }
    return out;
  }

  remainingBitsAreZero(): boolean {
    for (let bit = this.bitOffset; bit < this.buffer.length * 8; bit += 1) {
      const byteIndex = bit >> 3;
      const bitIndex = 7 - (bit & 7);
      const value = (this.buffer[byteIndex] >> bitIndex) & 0x01;
      if (value !== 0) return false;
    }
    return true;
  }
}

/* ----------------------- Octet-aligned RTP parsing ------------------------ */
/**
 * NOTE: These parsers remain for back-compat/tests, but Telnyx transcode is BE-only.
 */

export function tryParseAmrWbOctetAligned(payload: Buffer): OctetAlignedParseResult {
  if (payload.length < 2) return { ok: false, error: 'payload_too_short' };
  const cmr = (payload[0] >> 4) & 0x0f;

  let offset = 1;
  const frames: AmrWbFrameMeta[] = [];
  let follow = true;

  while (follow) {
    if (offset >= payload.length) return { ok: false, error: 'toc_truncated', cmr };
    const toc = payload[offset++] as number;
    follow = (toc & 0x80) !== 0;
    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;

    if (isAmrWbInvalidFt(ft)) return { ok: false, error: `invalid_ft_${ft}`, cmr };

    const sizeBytes = amrWbSpeechBytes(ft);
    if (sizeBytes === null) return { ok: false, error: `invalid_ft_${ft}`, cmr };

    frames.push({
      ft,
      q,
      sizeBytes,
      isSpeech: ft >= 0 && ft <= 8,
      isSid: ft === 9,
      isNoData: ft === 15,
    });

    if (!follow) break;
  }

  if (frames.length === 0) return { ok: false, error: 'missing_toc', cmr };

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

export function tryParseAmrWbOctetAlignedNoCmr(payload: Buffer): OctetAlignedParseResult {
  if (payload.length < 1) return { ok: false, error: 'payload_too_short' };

  let offset = 0;
  const frames: AmrWbFrameMeta[] = [];
  let follow = true;

  while (follow) {
    if (offset >= payload.length) return { ok: false, error: 'toc_truncated' };
    const toc = payload[offset++] as number;
    follow = (toc & 0x80) !== 0;
    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;

    if (isAmrWbInvalidFt(ft)) return { ok: false, error: `invalid_ft_${ft}` };

    const sizeBytes = amrWbSpeechBytes(ft);
    if (sizeBytes === null) return { ok: false, error: `invalid_ft_${ft}` };

    frames.push({
      ft,
      q,
      sizeBytes,
      isSpeech: ft >= 0 && ft <= 8,
      isSid: ft === 9,
      isNoData: ft === 15,
    });

    if (!follow) break;
  }

  if (frames.length === 0) return { ok: false, error: 'missing_toc' };

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

/* -------------------- Bandwidth-Efficient (BE) parsing -------------------- */

export function depacketizeAmrWbBandwidthEfficient(payload: Buffer): BeDepacketizeResult {
  if (payload.length === 0) return { ok: false, error: 'payload_too_short' };
  const reader = new BitReader(payload);

  const cmr = reader.readBits(4);
  if (cmr === null) return { ok: false, error: 'cmr_truncated' };

  const tocEntries: Array<{ ft: number; q: number; follow: number }> = [];
  let follow = 1;

  while (follow === 1) {
    const fBit = reader.readBits(1);
    const ft = reader.readBits(4);
    const q = reader.readBits(1);

    if (fBit === null || ft === null || q === null) return { ok: false, error: 'toc_truncated', cmr };
    if (isAmrWbInvalidFt(ft)) return { ok: false, error: `invalid_ft_${ft}`, cmr };

    tocEntries.push({ ft, q, follow: fBit });
    follow = fBit;
  }

  if (tocEntries.length === 0) return { ok: false, error: 'missing_toc', cmr };

  const frames: AmrWbFrameBitsMeta[] = [];
  for (const entry of tocEntries) {
    const bitLen = amrWbSpeechBits(entry.ft);
    if (bitLen === null) return { ok: false, error: `invalid_ft_${entry.ft}`, cmr };

    let data: Buffer = Buffer.alloc(0);
    if (bitLen > 0) {
      const bits = reader.readBitsToBuffer(bitLen);
      if (!bits) return { ok: false, error: `frame_truncated_ft_${entry.ft}`, cmr };
      data = bits as Buffer;
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

/**
 * Back-compat export: some callers still import this.
 *
 * If opts.hasCmr=true (normal Telnyx BE), this is identical to depacketizeAmrWbBandwidthEfficient().
 * If opts.hasCmr=false, we parse BE without consuming the initial 4-bit CMR (legacy/rare).
 */
export function depacketizeAmrWbBandwidthEfficientNoCmr(
  payload: Buffer,
  opts: { hasCmr: boolean } = { hasCmr: true },
): BeDepacketizeResult {
  if (opts.hasCmr) return depacketizeAmrWbBandwidthEfficient(payload);

  if (payload.length === 0) return { ok: false, error: 'payload_too_short' };
  const reader = new BitReader(payload);

  const tocEntries: Array<{ ft: number; q: number; follow: number }> = [];
  let follow = 1;

  while (follow === 1) {
    const fBit = reader.readBits(1);
    const ft = reader.readBits(4);
    const q = reader.readBits(1);

    if (fBit === null || ft === null || q === null) return { ok: false, error: 'toc_truncated' };
    if (isAmrWbInvalidFt(ft)) return { ok: false, error: `invalid_ft_${ft}` };

    tocEntries.push({ ft, q, follow: fBit });
    follow = fBit;
  }

  if (tocEntries.length === 0) return { ok: false, error: 'missing_toc' };

  const frames: AmrWbFrameBitsMeta[] = [];
  for (const entry of tocEntries) {
    const bitLen = amrWbSpeechBits(entry.ft);
    if (bitLen === null) return { ok: false, error: `invalid_ft_${entry.ft}` };

    let data: Buffer = Buffer.alloc(0);
    if (bitLen > 0) {
      const bits = reader.readBitsToBuffer(bitLen);
      if (!bits) return { ok: false, error: `frame_truncated_ft_${entry.ft}` };
      data = bits as Buffer;
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
    return { ok: false, error: 'trailing_bits_nonzero' };
  }

  // No CMR field present; preserve old return shape by setting cmr=0.
  return { ok: true, frames, cmr: 0, tocCount: tocEntries.length };
}

/**
 * Back-compat export: tests/older code may import this.
 * Converts BE frames -> OCTET-ALIGNED RTP payload bytes (optional 1-byte CMR).
 *
 * NOTE: pipeline does NOT use this; Telnyx transcode is BE-only and outputs storage frames.
 */
export function repackToOctetAlignedFromBe(
  be: Extract<BeDepacketizeResult, { ok: true }>,
  opts: { includeCmr: boolean } = { includeCmr: true },
): Buffer {
  const parts: Buffer[] = [];

  if (opts.includeCmr) {
    const cmrNibble = (be.cmr ?? 0) & 0x0f;
    parts.push(Buffer.from([(cmrNibble << 4) & 0xf0]));
  }

  for (let i = 0; i < be.frames.length; i += 1) {
    const fr = be.frames[i]!;
    const isLast = i === be.frames.length - 1;
    const fBit = isLast ? 0 : 1;
    const toc = ((fBit & 0x01) << 7) | ((fr.ft & 0x0f) << 3) | ((fr.q & 0x01) << 2);
    parts.push(Buffer.from([toc]));
  }

  for (const fr of be.frames) {
    if (fr.data.length > 0) parts.push(fr.data);
  }

  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

/* ------------------------ Storage helpers + artifacts ------------------------ */

function stripAmrWbHeaderIfPresent(buf: Buffer): Buffer {
  if (buf.length >= AMRWB_STREAM_HEADER.length) {
    const head = buf.subarray(0, AMRWB_STREAM_HEADER.length);
    if (head.equals(AMRWB_STREAM_HEADER)) return buf.subarray(AMRWB_STREAM_HEADER.length);
  }
  return buf;
}

function looksLikeAmrWbStorageFrames(buf: Buffer): boolean {
  const b = stripAmrWbHeaderIfPresent(buf);
  if (b.length < 1) return false;

  const toc0 = b[0] as number;

  // Storage TOC must have F=0. If F=1, this is not storage (often BE misread).
  if ((toc0 & 0x80) !== 0) return false;

  const ft0 = (toc0 >> 3) & 0x0f;
  if (isAmrWbInvalidFt(ft0)) return false;

  const size0 = amrWbSpeechBytes(ft0);
  if (size0 === null) return false;

  // Extra: reject if we'd need more bytes than exist
  if (b.length < 1 + size0) return false;

  return true;
}


function ensureAmrWbStreamHeader(buf: Buffer): Buffer {
  if (buf.length >= AMRWB_STREAM_HEADER.length && buf.subarray(0, AMRWB_STREAM_HEADER.length).equals(AMRWB_STREAM_HEADER)) {
    return buf;
  }
  return Buffer.concat([AMRWB_STREAM_HEADER, buf]);
}

/**
 * Convert octet-aligned RTP payload (with or without CMR) -> storage frames bytes (no header).
 * Storage TOC bytes MUST have F=0.
 */
function buildStorageFromOctetAligned(
  payload: Buffer,
  parsed: Extract<OctetAlignedParseResult, { ok: true }>,
  hasCmr: boolean,
): Buffer {
  const tocBytes = parsed.tocBytes;
  const dataOffset = (hasCmr ? 1 : 0) + tocBytes;

  let cursor = dataOffset;
  const outParts: Buffer[] = [];

  for (const f of parsed.frames) {
    // storage TOC byte: F=0, FT, Q, rest 0
    const tocByte = ((f.ft & 0x0f) << 3) | ((f.q & 0x01) << 2);
    outParts.push(Buffer.from([tocByte]));

    if (f.sizeBytes > 0) {
      outParts.push(payload.subarray(cursor, cursor + f.sizeBytes));
      cursor += f.sizeBytes;
    }
  }

  return outParts.length === 1 ? outParts[0]! : Buffer.concat(outParts);
}

/**
 * Convert storage frames bytes -> .awb storage file bytes (with "#!AMR-WB\n")
 * If frames already include header, keep it.
 */
function storageFramesToAwb(storageBytesOrAwb: Buffer): Buffer {
  return ensureAmrWbStreamHeader(storageBytesOrAwb);
}

/**
 * For artifact writing:
 * - If input is already storage frames (or has "#!AMR-WB\n"), write it directly.
 * - Else treat as octet-aligned RTP and convert to storage .awb using hasCmr flag.
 *
 * NOTE: This does NOT get used by the BE-only transcode path (it outputs storage frames already),
 * but remains useful for debugging legacy inputs.
 */
export function writeAmrwbArtifacts(
  label: string,
  payloadOrStorage: Buffer,
  opts: { hasCmr: boolean; meta?: Record<string, unknown> } = { hasCmr: true },
): void {
  const enabled = parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG) || amrwbRepackDebugEnabled();
  if (!enabled) return;

  const dir = amrwbDebugDir();
  safeMkdir(dir);

  const stamp = Date.now();
  const base = `${label}__${stamp}`;

  const rawPath = path.join(dir, `${base}__bytes.bin`);
  const awbPath = path.join(dir, `${base}__storage.awb`);

  try {
    fs.writeFileSync(rawPath, payloadOrStorage);

    const alreadyHasHeader = stripAmrWbHeaderIfPresent(payloadOrStorage) !== payloadOrStorage;
    const looksStorage = looksLikeAmrWbStorageFrames(payloadOrStorage);

    const writeValidatedAwb = (
      storageBytes: Buffer,
      treatedAs: 'storage' | 'octet_aligned',
      extraMeta?: Record<string, unknown>,
    ): void => {
      const meta = { ...(opts.meta ?? {}), ...(extraMeta ?? {}) };
      const validation = validateAmrWbStorageFramesBytes(storageBytes);
      const invalidTotal = totalInvalidAmrWbStorageFrames(validation.stats);
      const frames = validation.frames;

      if (invalidTotal > 0) {
        log.warn(
          {
            event: 'amrwb_storage_invalid_frames_dropped',
            label,
            dropped_bad_f: validation.stats.badF,
            dropped_bad_ft: validation.stats.badFt,
            dropped_bad_length: validation.stats.badLength,
            dropped_total: invalidTotal,
            kept_frames: frames.length,
            treated_as: treatedAs,
            ...meta,
          },
          'AMR-WB artifacts dropped invalid storage frames',
        );
      }

      if (frames.length === 0) {
        log.warn(
          { event: 'amrwb_artifacts_no_valid_frames', label, treated_as: treatedAs, ...meta },
          'AMR-WB artifacts: no valid storage frames to write',
        );
        return;
      }

      const payload = frames.length === 1 ? frames[0]! : Buffer.concat(frames);
      const awb = storageFramesToAwb(payload);
      fs.writeFileSync(awbPath, awb);

      log.info(
        {
          event: 'amrwb_artifacts_written',
          label,
          raw_bytes: rawPath,
          storage_awb: awbPath,
          bytes_len: payloadOrStorage.length,
          treated_as: treatedAs,
          dropped_bad_f: validation.stats.badF,
          dropped_bad_ft: validation.stats.badFt,
          dropped_bad_length: validation.stats.badLength,
          dropped_total: invalidTotal,
          ...meta,
        },
        `AMR-WB artifacts written (${treatedAs})`,
      );
    };

    // If it already looks like storage frames or already includes "#!AMR-WB\n", validate and write.
    if (looksStorage || alreadyHasHeader) {
      const storageBytes = stripAmrWbHeaderIfPresent(payloadOrStorage);
      writeValidatedAwb(storageBytes, 'storage');
      return;
    }

    // NEW: do not "guess" octet-aligned unless explicitly told.
    // This prevents BE / unknown bytes from being mis-parsed and creating confusing .awb artifacts.
    const explicitOctet = Boolean((opts.meta as any)?.explicitOctetAligned);
    if (!explicitOctet) {
      log.info(
        {
          event: 'amrwb_artifacts_written_raw_only',
          label,
          raw_bytes: rawPath,
          bytes_len: payloadOrStorage.length,
          treated_as: 'raw_only',
          ...(opts.meta ?? {}),
        },
        'AMR-WB artifacts: wrote raw only (format unknown; not attempting octet-aligned parse)',
      );
      return;
    }

    // Otherwise, treat as octet-aligned RTP payload and convert (ONLY when explicitly requested).
    const parsed = opts.hasCmr
      ? tryParseAmrWbOctetAligned(payloadOrStorage)
      : tryParseAmrWbOctetAlignedNoCmr(payloadOrStorage);

    if (!parsed.ok) {
      log.warn(
        {
          event: 'amrwb_artifact_storage_build_failed',
          label,
          error: parsed.error,
          hasCmr: opts.hasCmr,
          ...(opts.meta ?? {}),
        },
        'AMR-WB artifact: failed to parse octet-aligned bytes for .awb',
      );
      return;
    }

    const storageFrames = buildStorageFromOctetAligned(payloadOrStorage, parsed, opts.hasCmr);
    writeValidatedAwb(storageFrames, 'octet_aligned', { hasCmr: opts.hasCmr, toc_count: parsed.frames.length });
  } catch (err) {
    log.warn({ event: 'amrwb_artifacts_write_failed', label, err: String(err) }, 'AMR-WB artifact write failed');
  }
}

/* ------------------------------ Main transcoder ----------------------------- */
/**
 * TELNYX BE-ONLY CONTRACT:
 * - Input may include RTP header or may be payload-only.
 * - MUST be Bandwidth-Efficient (bit-packed).
 * - Output is ALWAYS "storage frames bytes" (no "#!AMR-WB\n" header).
 * - If BE parsing fails, we DO NOT fall back to any octet-aligned heuristics.
 *
 * This is the “no drift” guarantee.
 */
export function transcodeTelnyxAmrWbPayload(input: Buffer): TranscodeAmrWbResult {
  const stripped = detectAndStripRtpHeader(input);
  const payload = stripped.payload;
  const now = Date.now();

  const be = depacketizeAmrWbBandwidthEfficient(payload);
  if (!be.ok) {
    const error = `be_only_reject:${be.error}`;

    if (shouldLogAmrwbRepackDebug(now)) {
      log.info(
        {
          event: 'amrwb_repack_path',
          path: 'invalid_be_only',
          payload_len: payload.length,
          rtp_stripped: stripped.stripped,
          error,
        },
        'AMR-WB repack path selected',
      );
    }

    return {
      ok: false,
      packing: 'invalid',
      rtpStripped: stripped.stripped,
      error,
      totalBytesIn: input.length,
    };
  }

  // Build storage frames bytes from BE frames: storage TOC byte always has F=0
  const outParts: Buffer[] = [];
  for (const fr of be.frames) {
    const tocByte = ((fr.ft & 0x0f) << 3) | ((fr.q & 0x01) << 2); // F=0
    outParts.push(Buffer.from([tocByte]));
    if (fr.data.length > 0) outParts.push(fr.data);
  }
  const output = outParts.length === 1 ? outParts[0]! : Buffer.concat(outParts);

  if (shouldLogAmrwbRepackDebug(now)) {
    log.info(
      {
        event: 'amrwb_repack_path',
        path: 'be_to_storage',
        payload_len: payload.length,
        rtp_stripped: stripped.stripped,
        toc_count: be.tocCount,
        cmr: be.cmr ?? null,
        total_bytes_out: output.length,
      },
      'AMR-WB repack path selected',
    );
  }

  return {
    ok: true,
    packing: 'be',
    rtpStripped: stripped.stripped,
    output,
    tocCount: be.tocCount,
    totalBytesIn: input.length,
    totalBytesOut: output.length,
    cmr: be.cmr ?? undefined,
    cmrStripped: true,
  };
}

// (Optional) exported for reuse elsewhere if needed
export { ensureAmrWbStreamHeader };
