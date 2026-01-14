import { log } from '../log';

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
      packing: 'octet' | 'be';
      rtpStripped: boolean;
      output: Buffer;
      tocCount: number;
      totalBytesIn: number;
      totalBytesOut: number;
      cmrStripped?: boolean;
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
const AMRWB_NO_DATA_FTS = new Set([14, 15]);
const AMRWB_REPACK_DEBUG_MAX = 30;
const AMRWB_REPACK_DEBUG_INTERVAL_MS = 1000;

let amrwbRepackDebugCount = 0;
let amrwbRepackDebugLastLogAt = 0;

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function amrwbRepackDebugEnabled(): boolean {
  return parseBoolEnv(process.env.AMRWB_REPACK_DEBUG);
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

function isAmrWbInvalidFt(ft: number): boolean {
  return ft >= 10 && ft <= 13;
}

function amrWbSpeechBits(ft: number): number | null {
  if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BITS.length) return AMRWB_SPEECH_FRAME_BITS[ft] ?? null;
  if (ft === 9) return AMRWB_SID_BITS;
  if (AMRWB_NO_DATA_FTS.has(ft)) return 0;
  return null;
}

function amrWbSpeechBytes(ft: number): number | null {
  if (ft >= 0 && ft < AMRWB_SPEECH_FRAME_BYTES.length) return AMRWB_SPEECH_FRAME_BYTES[ft] ?? null;
  if (ft === 9) return AMRWB_SID_BYTES;
  if (AMRWB_NO_DATA_FTS.has(ft)) return 0;
  return null;
}

type OctetAlignedCmrProbe = {
  ok: boolean;
  cmr: number;
  toc: number;
  ft: number;
  q: number;
  follow: number;
  paddingBits: number;
};

function probeOctetAlignedCmr(payload: Buffer): OctetAlignedCmrProbe {
  if (payload.length < 2) {
    return { ok: false, cmr: 0, toc: 0, ft: 0, q: 0, follow: 0, paddingBits: 0 };
  }
  const cmr = (payload[0] >> 4) & 0x0f;
  const toc = payload[1] as number;
  const ft = (toc >> 3) & 0x0f;
  const q = (toc >> 2) & 0x01;
  const follow = (toc >> 7) & 0x01;
  const paddingBits = toc & 0x03;
  const ok = cmr >= 0 && cmr <= 15 && ft >= 0 && ft <= 8 && paddingBits === 0;
  return { ok, cmr, toc, ft, q, follow, paddingBits };
}

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
      isNoData: AMRWB_NO_DATA_FTS.has(ft),
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
      isNoData: AMRWB_NO_DATA_FTS.has(ft),
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

    let data = Buffer.alloc(0);
    if (bitLen > 0) {
      const bits = reader.readBitsToBuffer(bitLen);
      if (!bits) return { ok: false, error: `frame_truncated_ft_${entry.ft}`, cmr };
      data = bits;
    }

    frames.push({
      ft: entry.ft,
      q: entry.q,
      bitLen,
      data,
      isSpeech: entry.ft >= 0 && entry.ft <= 8,
      isSid: entry.ft === 9,
      isNoData: AMRWB_NO_DATA_FTS.has(entry.ft),
    });
  }

  if (reader.remainingBits() > 0 && !reader.remainingBitsAreZero()) {
    return { ok: false, error: 'trailing_bits_nonzero', cmr };
  }

  return { ok: true, frames, cmr, tocCount: tocEntries.length };
}

export function depacketizeAmrWbBandwidthEfficientNoCmr(
  payload: Buffer,
  opts: { hasCmr?: boolean } = {},
): BeDepacketizeResult {
  if (payload.length === 0) return { ok: false, error: 'payload_too_short' };
  const reader = new BitReader(payload);
  let cmr = 15;
  if (opts.hasCmr) {
    const cmrBits = reader.readBits(4);
    if (cmrBits === null) return { ok: false, error: 'cmr_truncated' };
    cmr = cmrBits;
  }

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

    let data = Buffer.alloc(0);
    if (bitLen > 0) {
      const bits = reader.readBitsToBuffer(bitLen);
      if (!bits) return { ok: false, error: `frame_truncated_ft_${entry.ft}`, cmr };
      data = bits;
    }

    frames.push({
      ft: entry.ft,
      q: entry.q,
      bitLen,
      data,
      isSpeech: entry.ft >= 0 && entry.ft <= 8,
      isSid: entry.ft === 9,
      isNoData: AMRWB_NO_DATA_FTS.has(entry.ft),
    });
  }

  if (reader.remainingBits() > 0 && !reader.remainingBitsAreZero()) {
    return { ok: false, error: 'trailing_bits_nonzero', cmr };
  }

  return { ok: true, frames, cmr, tocCount: tocEntries.length };
}

export function repackToOctetAlignedFromBe(beResult: Extract<BeDepacketizeResult, { ok: true }>): Buffer {
  const cmrByte = ((beResult.cmr ?? 0) & 0x0f) << 4;
  const toc = Buffer.alloc(beResult.frames.length);
  for (let i = 0; i < beResult.frames.length; i += 1) {
    const frame = beResult.frames[i]!;
    const follow = i < beResult.frames.length - 1 ? 1 : 0;
    toc[i] = (follow << 7) | ((frame.ft & 0x0f) << 3) | ((frame.q & 0x01) << 2);
  }

  const dataParts = beResult.frames.filter((frame) => frame.data.length > 0).map((frame) => frame.data);
  return Buffer.concat([Buffer.from([cmrByte]), toc, ...dataParts]);
}

export function transcodeTelnyxAmrWbPayload(input: Buffer): TranscodeAmrWbResult {
  const stripped = detectAndStripRtpHeader(input);
  const payload = stripped.payload;

  // Avoid payload-length heuristics; detect octet-aligned CMR by byte layout and strip CMR for decoding.
  const cmrProbe = probeOctetAlignedCmr(payload);
  if (cmrProbe.ok) {
    const payloadNoCmr = payload.subarray(1);
    const parsedNoCmr = tryParseAmrWbOctetAlignedNoCmr(payloadNoCmr);
    const tocCount = parsedNoCmr.ok ? parsedNoCmr.frames.length : 1;
    if (shouldLogAmrwbRepackDebug(Date.now())) {
      log.info(
        {
          event: 'amrwb_repack_path',
          path: 'octet_cmr_stripped',
          payload_len: payload.length,
          rtp_stripped: stripped.stripped,
          toc_count: tocCount,
          cmr: cmrProbe.cmr,
          toc_ft: cmrProbe.ft,
          toc_q: cmrProbe.q,
          toc_follow: cmrProbe.follow,
        },
        'AMR-WB repack path selected',
      );
    }
    return {
      ok: true,
      packing: 'octet',
      rtpStripped: stripped.stripped,
      output: payloadNoCmr,
      tocCount,
      totalBytesIn: input.length,
      totalBytesOut: payloadNoCmr.length,
      cmrStripped: true,
      cmr: cmrProbe.cmr,
    };
  }

  const octet = tryParseAmrWbOctetAligned(payload);
  if (octet.ok) {
    const payloadNoCmr = payload.subarray(1);
    if (shouldLogAmrwbRepackDebug(Date.now())) {
      log.info(
        {
          event: 'amrwb_repack_path',
          path: 'octet_cmr_stripped',
          payload_len: payload.length,
          rtp_stripped: stripped.stripped,
          toc_count: octet.frames.length,
          cmr: octet.cmr ?? null,
        },
        'AMR-WB repack path selected',
      );
    }
    return {
      ok: true,
      packing: 'octet',
      rtpStripped: stripped.stripped,
      output: payloadNoCmr,
      tocCount: octet.frames.length,
      totalBytesIn: input.length,
      totalBytesOut: payloadNoCmr.length,
      cmrStripped: true,
      cmr: octet.cmr ?? undefined,
    };
  }

  const octetNoCmr = tryParseAmrWbOctetAlignedNoCmr(payload);
  if (octetNoCmr.ok) {
    if (shouldLogAmrwbRepackDebug(Date.now())) {
      log.info(
        {
          event: 'amrwb_repack_path',
          path: 'octet_no_cmr',
          payload_len: payload.length,
          rtp_stripped: stripped.stripped,
          toc_count: octetNoCmr.frames.length,
          cmr: octetNoCmr.cmr ?? null,
        },
        'AMR-WB repack path selected',
      );
    }
    return {
      ok: true,
      packing: 'octet',
      rtpStripped: stripped.stripped,
      output: payload,
      tocCount: octetNoCmr.frames.length,
      totalBytesIn: input.length,
      totalBytesOut: payload.length,
    };
  }

  const be = depacketizeAmrWbBandwidthEfficient(payload);
  if (be.ok) {
    const output = repackToOctetAlignedFromBe(be);
    if (shouldLogAmrwbRepackDebug(Date.now())) {
      log.info(
        {
          event: 'amrwb_repack_path',
          path: 'bandwidth_efficient',
          payload_len: payload.length,
          rtp_stripped: stripped.stripped,
          toc_count: be.frames.length,
          cmr: be.cmr ?? null,
          repacked_len: output.length,
        },
        'AMR-WB repack path selected',
      );
    }
    return {
      ok: true,
      packing: 'be',
      rtpStripped: stripped.stripped,
      output,
      tocCount: be.frames.length,
      totalBytesIn: input.length,
      totalBytesOut: output.length,
    };
  }

  if (shouldLogAmrwbRepackDebug(Date.now())) {
    log.info(
      {
        event: 'amrwb_repack_path',
        path: 'invalid',
        payload_len: payload.length,
        rtp_stripped: stripped.stripped,
        error: `octet:${octet.error};be:${be.error}`,
      },
      'AMR-WB repack path selected',
    );
  }
  return {
    ok: false,
    packing: 'invalid',
    rtpStripped: stripped.stripped,
    error: `octet:${octet.error};be:${be.error}`,
    totalBytesIn: input.length,
  };
}
