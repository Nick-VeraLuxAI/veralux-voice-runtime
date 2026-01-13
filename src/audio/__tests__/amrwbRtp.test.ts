import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectAndStripRtpHeader,
  depacketizeAmrWbBandwidthEfficient,
  repackToOctetAlignedFromBe,
  transcodeTelnyxAmrWbPayload,
  tryParseAmrWbOctetAligned,
  tryParseAmrWbOctetAlignedNoCmr,
} from '../amrwbRtp';

function pushBits(target: number[], value: number, width: number): void {
  for (let i = width - 1; i >= 0; i -= 1) {
    target.push((value >> i) & 0x01);
  }
}

function packBits(bits: number[]): Buffer {
  const byteLen = Math.ceil(bits.length / 8);
  const buf = Buffer.alloc(byteLen);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === 1) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      buf[byteIndex] |= 1 << bitIndex;
    }
  }
  return buf;
}

function buildBeSingleFramePayload(ft: number, bitLen: number): Buffer {
  const bits: number[] = [];
  const cmr = 0x0f;
  const q = 1;

  pushBits(bits, cmr, 4);
  // TOC: F=0, FT=ft, Q=q
  pushBits(bits, 0, 1);
  pushBits(bits, ft, 4);
  pushBits(bits, q, 1);

  for (let i = 0; i < bitLen; i += 1) {
    bits.push(i === 0 ? 1 : 0);
  }

  return packBits(bits);
}

test('detectAndStripRtpHeader strips base header and extension', () => {
  const payload = Buffer.from([0xaa, 0xbb, 0xcc]);
  const header = Buffer.alloc(12);
  header[0] = 0x90; // V=2, X=1, CC=0
  header[1] = 0x60;

  const extension = Buffer.from([0x12, 0x34, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);
  const packet = Buffer.concat([header, extension, payload]);

  const result = detectAndStripRtpHeader(packet);
  assert.equal(result.stripped, true);
  assert.deepEqual(result.payload, payload);
});

test('detectAndStripRtpHeader removes RTP padding bytes', () => {
  const payload = Buffer.from([0xde, 0xad, 0xbe]);
  const padding = Buffer.from([0x00, 0x02]); // last byte is padding count
  const header = Buffer.alloc(12);
  header[0] = 0xa0; // V=2, P=1, X=0, CC=0
  header[1] = 0x60;

  const packet = Buffer.concat([header, payload, padding]);
  const result = detectAndStripRtpHeader(packet);
  assert.equal(result.stripped, true);
  assert.deepEqual(result.payload, payload);
});

test('tryParseAmrWbOctetAligned validates a single-frame payload', () => {
  const cmr = 0x0f;
  const toc = 0x04; // F=0, FT=0, Q=1
  const speech = Buffer.alloc(17);
  const payload = Buffer.concat([Buffer.from([cmr << 4]), Buffer.from([toc]), speech]);

  const result = tryParseAmrWbOctetAligned(payload);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0]?.sizeBytes, 17);
    assert.equal(result.tocBytes, 1);
    assert.equal(result.dataBytes, 17);
  }
});

test('depacketizeAmrWbBandwidthEfficient repacks to valid octet-aligned payload', () => {
  const bePayload = buildBeSingleFramePayload(0, 132);
  const be = depacketizeAmrWbBandwidthEfficient(bePayload);
  assert.equal(be.ok, true);
  if (!be.ok) return;

  const octet = repackToOctetAlignedFromBe(be);
  const parsed = tryParseAmrWbOctetAligned(octet);
  assert.equal(parsed.ok, true);
});

test('transcode does not accept 0xf1 0x6e as valid octet-aligned', () => {
  const payload = Buffer.from([0xf1, 0x6e, 0x00, 0x00]);
  const result = transcodeTelnyxAmrWbPayload(payload);
  assert.equal(result.ok, false);
  assert.equal(result.packing, 'invalid');
  assert.match(result.error ?? '', /invalid_ft_13/);
});

test('transcode accepts 33-byte octet-aligned payload without CMR', () => {
  const toc = (2 << 3) | (1 << 2); // F=0, FT=2, Q=1
  const speech = Buffer.alloc(32, 0x55);
  const payload = Buffer.concat([Buffer.from([toc]), speech]);

  const parsed = tryParseAmrWbOctetAlignedNoCmr(payload);
  assert.equal(parsed.ok, true);

  const result = transcodeTelnyxAmrWbPayload(payload);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.packing, 'octet');
    assert.equal(result.totalBytesOut, payload.length);
    assert.equal(result.tocCount, 1);
    assert.deepEqual(result.output, payload);
  }
});

test('transcode strips CMR byte when octet-aligned CMR is detected', () => {
  const cmr = 0x0f;
  const toc = (2 << 3) | (1 << 2); // F=0, FT=2, Q=1
  const speech = Buffer.alloc(32, 0x33);
  const payload = Buffer.concat([Buffer.from([cmr << 4]), Buffer.from([toc]), speech]);

  const result = transcodeTelnyxAmrWbPayload(payload);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.packing, 'octet');
  assert.equal(result.cmrStripped, true);
  assert.equal(result.cmr, cmr);
  assert.equal(result.totalBytesOut, payload.length - 1);
  assert.deepEqual(result.output, payload.subarray(1));
});
