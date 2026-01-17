/**
 * Prepare AMR-WB payloads for ffmpeg decoding.
 *
 * Telnyx commonly sends single-frame speech as 33 bytes (ToC + 32 bytes @ 12.65 kbps)
 * with NO leading CMR byte. That 33-byte case must be treated as octet-aligned no-CMR
 * ("amrwb") and should not be repacked.
 */
function prepareAmrWbPayload(
  payload: Buffer,
): { prepared: Buffer; ffmpegFormat: 'amrwb' | 'amrwb_ocmr' | 'amr-wb-be' } {
  function getHexPrefix(buf: Buffer, len = 16): string {
    return buf.subarray(0, len).toString('hex');
  }

  const length = payload.length;
  const firstByte = length > 0 ? payload[0] : 0;
  const first4Hex = getHexPrefix(payload, 4);

  const highNibble = (byte: number): number => (byte >> 4) & 0x0f;
  const lowNibble = (byte: number): number => byte & 0x0f;

  const isTelnyxNoCmrToc = (byte: number): boolean => {
    const hi = highNibble(byte);
    const lo = lowNibble(byte);
    const qSet = (byte & 0x04) !== 0;
    return hi === 0x0f && lo <= 9 && qSet;
  };

  if (length === 33 && isTelnyxNoCmrToc(firstByte)) {
    console.info('[amrwb_prepare] mode=amrwb', {
      length,
      prepared_length: payload.length,
      first4Hex,
    });
    return { prepared: payload, ffmpegFormat: 'amrwb' };
  }

  if (length === 34) {
    console.info('[amrwb_prepare] mode=amrwb_ocmr', {
      length,
      prepared_length: payload.length,
      first4Hex,
    });
    return { prepared: payload, ffmpegFormat: 'amrwb_ocmr' };
  }

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

  const looksLikeBeToc = (buf: Buffer, bitOffset: number): boolean => {
    const f = readBits(buf, bitOffset, 1);
    const ft = readBits(buf, bitOffset + 1, 4);
    const q = readBits(buf, bitOffset + 5, 1);
    if (f === null || ft === null || q === null) return false;
    return ft >= 0 && ft <= 9;
  };

  const prependCmrNibble = (buf: Buffer, cmr: number): Buffer => {
    if (buf.length === 0) {
      return Buffer.from([((cmr & 0x0f) << 4) & 0xf0]);
    }
    const out = Buffer.alloc(buf.length + 1);
    out[0] = ((cmr & 0x0f) << 4) | ((buf[0] >> 4) & 0x0f);
    for (let i = 1; i < buf.length; i += 1) {
      out[i] = ((buf[i - 1] << 4) & 0xf0) | ((buf[i] >> 4) & 0x0f);
    }
    out[buf.length] = (buf[buf.length - 1] << 4) & 0xf0;
    return out;
  };

  let prepared = payload;
  let addedCmr = false;
  if (payload.length > 0) {
    const hasCmr = looksLikeBeToc(payload, 4);
    const noCmr = looksLikeBeToc(payload, 0);
    if (!hasCmr && noCmr) {
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
  });

  return { prepared, ffmpegFormat: 'amr-wb-be' };
}

export { prepareAmrWbPayload };
