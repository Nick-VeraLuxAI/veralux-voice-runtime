/**
 * Prepare AMR-WB payloads for ffmpeg decoding.
 *
 * We support three “shapes”:
 *  1) Octet-aligned *storage-style* single frame, no CMR byte:
 *      [ TOC (1 byte) | frame payload bytes... ]  => often 33 bytes for FT=2 (0x14 + 32)
 *  2) Octet-aligned with a leading CMR byte:
 *      [ CMR (1 byte) | TOC (1 byte) | frame payload bytes... ]
 *  3) Bandwidth-efficient (bit-packed) as Telnyx often delivers in RTP:
 *      Often begins with CMR nibble, then TOC bits, then speech bits.
 *
 * IMPORTANT:
 * - A first byte like 0xF1 is NOT a valid octet-aligned TOC for speech.
 *   It usually indicates BE (CMR nibble = 0xF plus some TOC bits).
 */
function prepareAmrWbPayload(
  payload: Buffer,
): { prepared: Buffer; ffmpegFormat: 'amrwb' | 'amrwb_ocmr' | 'amr-wb-be' } {
  const getHexPrefix = (buf: Buffer, len = 16): string => buf.subarray(0, len).toString('hex');

  const length = payload.length;
  const firstByte = length > 0 ? payload[0] : 0;
  const first4Hex = getHexPrefix(payload, 4);

  // AMR-WB frame payload byte lengths by FT (speech only + SID + no-data)
  // These are the standard octet-aligned frame payload sizes (excluding the TOC byte).
  // (FT=9 is SID; FT=15 is No Data.)
  const FRAME_BYTES_BY_FT: Record<number, number> = {
    0: 17,
    1: 23,
    2: 32,
    3: 36,
    4: 40,
    5: 46,
    6: 50,
    7: 58,
    8: 60,
    9: 5, // SID
    15: 0, // No Data
  };

  const isValidOctetAlignedToc = (toc: number): { ok: boolean; ft?: number; q?: number } => {
    // Octet-aligned TOC: [F:1][FT:4][Q:1][P:2]
    const f = (toc >> 7) & 0x01;
    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;
    const p = toc & 0x03;

    // For *single frame* storage-style chunks, F should be 0 (no more frames).
    // P bits should be 0 in storage-style TOC.
    if (f !== 0) return { ok: false };
    if (p !== 0) return { ok: false };

    // Allow speech (0..8), SID (9), No Data (15)
    if (!(ft === 15 || ft === 9 || (ft >= 0 && ft <= 8))) return { ok: false };

    return { ok: true, ft, q };
  };

  const octetAlignedNoCmrMatch = (): boolean => {
    if (length < 2) return false;
    const tocInfo = isValidOctetAlignedToc(payload[0]);
    if (!tocInfo.ok || tocInfo.ft === undefined) return false;
    const frameBytes = FRAME_BYTES_BY_FT[tocInfo.ft];
    if (frameBytes === undefined) return false;

    // total = 1 TOC + frameBytes
    return length === 1 + frameBytes;
  };

  const octetAlignedWithCmrMatch = (): boolean => {
    if (length < 3) return false;
    // CMR is a full byte in octet-aligned-with-CMR shape.
    // Second byte should be a valid TOC.
    const tocInfo = isValidOctetAlignedToc(payload[1]);
    if (!tocInfo.ok || tocInfo.ft === undefined) return false;
    const frameBytes = FRAME_BYTES_BY_FT[tocInfo.ft];
    if (frameBytes === undefined) return false;

    // total = 1 CMR + 1 TOC + frameBytes
    return length === 2 + frameBytes;
  };

  // --- Fast-path: octet-aligned single frame (no CMR byte) ---
  if (octetAlignedNoCmrMatch()) {
    console.info('[amrwb_prepare] mode=amrwb', {
      length,
      prepared_length: payload.length,
      first4Hex,
      toc_hex: payload[0].toString(16).padStart(2, '0'),
    });
    return { prepared: payload, ffmpegFormat: 'amrwb' };
  }

  // --- Fast-path: octet-aligned with CMR byte ---
  if (octetAlignedWithCmrMatch()) {
    console.info('[amrwb_prepare] mode=amrwb_ocmr', {
      length,
      prepared_length: payload.length,
      first4Hex,
      cmr_hex: payload[0].toString(16).padStart(2, '0'),
      toc_hex: payload[1].toString(16).padStart(2, '0'),
    });
    return { prepared: payload, ffmpegFormat: 'amrwb_ocmr' };
  }

  // -------------------------
  // Otherwise treat as BE (bit-packed)
  // -------------------------

  const readBits = (buf: Buffer, startBit: number, count: number): number | null => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const bitIndex = startBit + i;
      const byteIndex = bitIndex >> 3;
      if (byteIndex >= buf.length) return null;
      const bitOffset = 7 - (bitIndex & 7);
      const bit = (buf[byteIndex] >> bitOffset) & 0x01;
      value = (value << 1) | bit;
    }
    return value;
  };

  const looksLikeBeTocAt = (buf: Buffer, bitOffset: number): boolean => {
    // BE TOC: F(1), FT(4), Q(1) immediately after optional CMR nibble
    const f = readBits(buf, bitOffset, 1);
    const ft = readBits(buf, bitOffset + 1, 4);
    const q = readBits(buf, bitOffset + 5, 1);
    if (f === null || ft === null || q === null) return false;

    // For our capture chunks we only expect a single frame => F should be 0
    if (f !== 0) return false;

    // Allow speech (0..8), SID (9), No Data (15)
    if (!(ft === 15 || ft === 9 || (ft >= 0 && ft <= 8))) return false;

    return true;
  };

  const prependCmrNibble = (buf: Buffer, cmr: number): Buffer => {
    // Prepend 4 bits of CMR before the existing bitstream.
    // This shifts the entire stream by 4 bits, adding one byte at the end.
    if (buf.length === 0) return Buffer.from([((cmr & 0x0f) << 4) & 0xf0]);

    const out = Buffer.alloc(buf.length + 1);
    out[0] = ((cmr & 0x0f) << 4) | ((buf[0] >> 4) & 0x0f);
    for (let i = 1; i < buf.length; i += 1) {
      out[i] = ((buf[i - 1] << 4) & 0xf0) | ((buf[i] >> 4) & 0x0f);
    }
    out[buf.length] = (buf[buf.length - 1] << 4) & 0xf0;
    return out;
  };

  // Detect whether BE already includes a CMR nibble:
  // - If TOC looks valid at bitOffset=4, we assume there is a CMR nibble
  // - If TOC looks valid at bitOffset=0 but not at 4, we assume missing CMR nibble
  let prepared = payload;
  let addedCmr = false;

  if (payload.length > 0) {
    const hasCmrNibble = looksLikeBeTocAt(payload, 4);
    const noCmrNibble = looksLikeBeTocAt(payload, 0);

    if (!hasCmrNibble && noCmrNibble) {
      // Telnyx sometimes omits the CMR nibble; use 0xF as “no preference”
      prepared = prependCmrNibble(payload, 0x0f);
      addedCmr = true;
    }
  }

  console.info('[amrwb_prepare] mode=amr-wb-be', {
    length,
    prepared_length: prepared.length,
    first4Hex,
    prepared_first4_hex: getHexPrefix(prepared, 4),
    added_cmr: addedCmr,
    first_byte_hex: firstByte.toString(16).padStart(2, '0'),
  });

  return { prepared, ffmpegFormat: 'amr-wb-be' };
}

export { prepareAmrWbPayload };
