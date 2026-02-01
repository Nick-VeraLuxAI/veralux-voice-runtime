// src/media/mediaIngest.ts
import fs from 'fs';
import path from 'path';

import { closeTelnyxCodecState, decodeTelnyxPayloadToPcm16, type TelnyxCodecState } from '../audio/codecDecode';
import { prepareAmrWbPayload } from '../audio/prepareAmrWbPayload';
import { DebugAudioTap } from '../audio/debugAudioTap';

import { attachAudioMeta, diagnosticsEnabled, markAudioSpan, probePcm } from '../diagnostics/audioProbe';
import type { AudioMeta } from '../diagnostics/audioProbe';
import { log } from '../log';
import type { TransportMode } from '../transport/types';

type Base64Encoding = 'base64' | 'base64url';

type PayloadCandidate = { source: string; value: string };

type TrackFields = {
  mediaTrack?: string;
  msgTrack?: string;
  streamTrack?: string;
  dataTrack?: string;
};

export type MediaIngestFrame = {
  callControlId: string;
  pcm16: Int16Array;
  sampleRateHz: number;
  channels: 1;
  timestamp?: number;
  seq?: number;
};

export type MediaIngestUnhealthyReason = 'low_rms' | 'decode_failures' | 'tiny_payloads';

export type MediaIngestUnhealthyEvent = {
  callControlId: string;
  reason: MediaIngestUnhealthyReason;
  codec: string;
  totalFrames: number;
  decodedFrames: number;
  silentFrames: number;
  tinyPayloadFrames: number;
  decodeFailures: number;
  lastRms: number;
  lastPeak: number;
};

/**
 * Emitted when a media payload has been:
 * - chosen from candidates
 * - base64-decoded into raw bytes
 * - passed minimal length checks
 * - passed track gating
 *
 * This is useful for server-side visibility without dumping full payloads.
 */
export type MediaIngestAcceptedPayloadTap = {
  callControlId: string;
  codec: string;
  track: string | null;
  normalizedTrack: string | null;
  seq: number;
  timestamp: number | null;
  payloadSource: string | null;
  payloadLen: number;
  decodedLen: number;
  hexPrefix: string;

  // Optional session hooks (for log gating / debugging)
  playbackActive?: boolean;
  listening?: boolean;
  lastSpeechStartAtMs?: number | null;
};

export type MediaIngestOptions = {
  callControlId: string;
  transportMode: TransportMode;
  expectedTrack?: string;
  acceptCodecs: Set<string>;
  targetSampleRateHz: number;
  allowAmrWb: boolean;
  allowG722: boolean;
  allowOpus: boolean;
  logContext?: Record<string, unknown>;
  onFrame: (frame: MediaIngestFrame) => void;
  onRestartStreaming?: (codec: string, reason: MediaIngestUnhealthyReason) => Promise<boolean> | boolean;
  onReprompt?: (reason: MediaIngestUnhealthyReason) => void;
  maxRestartAttempts?: number;

  // Optional session state hooks (used for log gating / debugging)
  isPlaybackActive?: () => boolean;
  isListening?: () => boolean;
  getLastSpeechStartAtMs?: () => number | null;

  // Optional tap hook (used by server.ts)
  onAcceptedPayload?: (tap: MediaIngestAcceptedPayloadTap) => void;
};

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
let captureActiveCallId: string | null = null;

const SENSITIVE_KEY_REGEX = /(token|authorization|auth|signature|secret|api_key)/i;
const AMRWB_FILE_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');
const AMRWB_CONTRACT_TEXT =
  'amr-wb contract\n' +
  '- inbound: telnyx amr-wb bandwidth-efficient (BE)\n' +
  '- canonical: amr-wb storage frames bytes (TOC F=0), .awb = "#!AMR-WB\\n" + storage frames\n' +
  '- whisper: wav pcm16 16k mono (decoded from canonical storage stream)\n';

/* ---------------------------------- env ---------------------------------- */

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function mediaSchemaDebugEnabled(): boolean {
  return parseBoolEnv(process.env.TELNYX_DEBUG_MEDIA_SCHEMA);
}

function telnyxTapRawEnabled(): boolean {
  return parseBoolEnv(process.env.TELNYX_DEBUG_TAP_RAW);
}

function telnyxCaptureOnceEnabled(): boolean {
  return parseBoolEnv(process.env.TELNYX_CAPTURE_ONCE);
}

function telnyxCaptureCallId(): string | null {
  const raw = process.env.TELNYX_CAPTURE_CALL_ID;
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

function telnyxDebugDir(): string {
  return process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== ''
    ? process.env.STT_DEBUG_DIR.trim()
    : '/tmp/veralux-stt-debug';
}

function sttDebugDumpFramesEnabled(): boolean {
  return parseBoolEnv(process.env.STT_DEBUG_DUMP_FRAMES);
}

function sttDebugDumpCount(): number {
  const raw = process.env.STT_DEBUG_DUMP_COUNT;
  if (!raw) return DEFAULT_DEBUG_DUMP_COUNT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEBUG_DUMP_COUNT;
  return Math.floor(parsed);
}

function sttDebugDumpDir(): string {
  const raw = process.env.STT_DEBUG_DUMP_DIR;
  return raw && raw.trim() !== '' ? raw.trim() : '/tmp/veralux-stt-debug';
}

function amrwbTruthCaptureEnabled(): boolean {
  return parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB);
}

function resolveEmitMs(): number {
  const raw = process.env.STT_EMIT_MS ?? process.env.STT_MIN_EMIT_MS;
  if (!raw) return DEFAULT_EMIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EMIT_MS;
  return Math.max(MIN_EMIT_MS, Math.min(MAX_EMIT_MS, Math.round(parsed)));
}

function emitChunkDebugEnabled(): boolean {
  return telnyxTapRawEnabled() || parseBoolEnv(process.env.AUDIO_TAP) || diagnosticsEnabled();
}

function amrwbEmitDebugEnabled(): boolean {
  return parseBoolEnv(process.env.AMRWB_DECODE_DEBUG);
}


/* ------------------------------- sanitizers ------------------------------- */

function redactInline(value: string): string {
  let redacted = value;
  const token = process.env.MEDIA_STREAM_TOKEN;
  if (token && redacted.includes(token)) redacted = redacted.split(token).join('[redacted]');
  redacted = redacted.replace(/token=([^&\s]+)/gi, 'token=[redacted]');
  return redacted;
}

function sanitizeForCapture(value: unknown, pathParts: string[] = []): unknown {
  if (typeof value === 'string') {
    const key = pathParts[pathParts.length - 1] ?? '';
    if (SENSITIVE_KEY_REGEX.test(key)) return '[redacted]';
    if (key === 'payload') {
      const trimmed = value.trim();
      return `[payload len=${trimmed.length}]`;
    }
    return redactInline(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item, index) => sanitizeForCapture(item, pathParts.concat(String(index))));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) sanitized[key] = sanitizeForCapture(val, pathParts.concat(key));
    return sanitized;
  }
  return value;
}

function getHexPrefix(buf: Buffer, len = 16): string {
  return buf.subarray(0, len).toString('hex');
}

function looksLikeAmrWbMagic(buf: Buffer): boolean {
  return buf.length >= AMRWB_FILE_HEADER.length && buf.subarray(0, AMRWB_FILE_HEADER.length).equals(AMRWB_FILE_HEADER);
}



function looksLikeWavRiff(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

/* --------------------------------- buckets -------------------------------- */

function bucketLen(value: number): string {
  if (value < 10) return '<10';
  if (value < 50) return '10-49';
  if (value < 100) return '50-99';
  if (value < 200) return '100-199';
  if (value < 500) return '200-499';
  if (value < 1000) return '500-999';
  if (value < 2000) return '1000-1999';
  return '2000+';
}

function incrementBucket(target: Record<string, number>, value: number): void {
  const key = bucketLen(value);
  target[key] = (target[key] ?? 0) + 1;
}

/* ----------------------------- payload decoding ---------------------------- */

function looksLikeBase64(payload: string): boolean {
  const trimmed = payload.trim().replace(/=+$/, '');
  if (trimmed.length < 8) return false;
  return /^[A-Za-z0-9+/_-]+$/.test(trimmed);
}

function decodeTelnyxPayloadWithInfo(payload: string): { buffer: Buffer; encoding: Base64Encoding; trimmed: string } {
  let trimmed = payload.trim();
  const useBase64Url = trimmed.includes('-') || trimmed.includes('_');
  const encoding: Base64Encoding = useBase64Url ? 'base64url' : 'base64';
  const mod = trimmed.length % 4;
  if (mod !== 0) trimmed += '='.repeat(4 - mod);
  return { buffer: Buffer.from(trimmed, encoding), encoding, trimmed };
}

/* --------------------------- AMR-WB capture parse -------------------------- */

const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;
const AMRWB_SPEECH_LOST_FT = 14;
const AMRWB_NO_DATA_FT = 15;

function amrWbFrameSize(ft: number): number {
  if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length) return AMRWB_FRAME_SIZES[ft] ?? 0;
  if (ft === 9) return AMRWB_SID_FRAME_BYTES;
  return 0;
}
/**
 * Classify whether a payload is a valid AMR-WB single-frame payload
 * (octet-aligned, no CMR). This replaces the misleading
 * payload.length === 33 heuristic.
 */
function classifyAmrwbSingleFrame(payload: Buffer): {
  ok: boolean;
  reason: string;
  toc?: number;
  ft?: number;
  q?: boolean;
  expectedBytes?: number;
} {
  if (payload.length < 2) return { ok: false, reason: 'too_short' };

  const toc = payload[0] ?? 0;
  const f = (toc & 0x80) !== 0;          // Follow bit
  const ft = (toc >> 3) & 0x0f;          // Frame type
  const q = (toc & 0x04) !== 0;           // Quality bit

  // Multi-TOC or not a simple single-frame packet
  if (f) {
    return { ok: false, reason: 'f_bit_set_multi_toc_or_not_single_frame', toc, ft, q };
  }

  // Invalid frame types
  if (ft >= 10 && ft <= 13) {
    return { ok: false, reason: `invalid_ft_${ft}`, toc, ft, q };
  }

  // Not speech
  if (ft === 14) return { ok: false, reason: 'speech_lost_ft_14', toc, ft, q };
  if (ft === 15) return { ok: false, reason: 'no_data_ft_15', toc, ft, q };

  const speechBytes = ft === 9 ? AMRWB_SID_FRAME_BYTES : amrWbFrameSize(ft);
  if (!speechBytes) {
    return { ok: false, reason: `unknown_ft_${ft}`, toc, ft, q };
  }

  const expected = 1 + speechBytes; // TOC + speech bytes
  if (payload.length !== expected) {
    return {
      ok: false,
      reason: `len_mismatch_expected_${expected}_got_${payload.length}`,
      toc,
      ft,
      q,
      expectedBytes: expected,
    };
  }

  // Q=0 is still a frame (bad quality), do NOT treat as non-speech
  return { ok: true, reason: 'ok_single_frame', toc, ft, q, expectedBytes: expected };
}


type AmrWbDebugParseAttempt = {
  offset: number;
  ok: boolean;
  frames: number;
  reason?: string;
  invalidFt?: number;
  cmr?: number | null;
};

function debugParseAmrWbOctetAligned(payload: Buffer, startOffset: number): AmrWbDebugParseAttempt {
  // payload[0] is CMR when startOffset === 1 (octet-aligned mode).
  const cmr = startOffset === 1 ? (payload[0] >> 4) & 0x0f : null;
  if (payload.length === 0) return { offset: startOffset, ok: false, frames: 0, reason: 'empty', cmr };
  if (startOffset >= payload.length) {
    return { offset: startOffset, ok: false, frames: 0, reason: 'start_offset_out_of_range', cmr };
  }

  let offset = startOffset;
  const tocEntries: number[] = [];
  let follow = true;

  while (follow && offset < payload.length) {
    const toc = payload[offset++] as number;
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
    if (size <= 0) return { offset: startOffset, ok: false, frames, reason: `invalid_ft_${ft}`, invalidFt: ft, cmr };
    if (offset + size > payload.length) {
      return { offset: startOffset, ok: false, frames, reason: `frame_overflow_ft_${ft}`, cmr };
    }
    frames += 1;
    offset += size;
  }

  return { offset: startOffset, ok: true, frames, cmr };
}

function debugParseAmrWbPayload(payload: Buffer): {
  ok: boolean;
  mode: string;
  frames: number;
  reason?: string;
  attempts?: AmrWbDebugParseAttempt[];
} {
  if (payload.length === 0) return { ok: false, mode: 'empty', frames: 0, reason: 'empty' };
  if (AMRWB_FRAME_SIZES.includes(payload.length)) return { ok: true, mode: 'single', frames: 1 };
  if (payload.length === AMRWB_SID_FRAME_BYTES) return { ok: true, mode: 'sid', frames: 0 };
  if (payload.length < 2) return { ok: false, mode: 'too_short', frames: 0, reason: 'payload_too_short' };

  const withCmr = debugParseAmrWbOctetAligned(payload, 1);
  if (withCmr.ok) return { ok: true, mode: 'octet_cmr', frames: withCmr.frames };

  const withoutCmr = debugParseAmrWbOctetAligned(payload, 0);
  if (withoutCmr.ok) return { ok: true, mode: 'octet_no_cmr', frames: withoutCmr.frames };

  return {
    ok: false,
    mode: 'octet_failed',
    frames: 0,
    reason: `${withCmr.reason ?? 'unknown'}|${withoutCmr.reason ?? 'unknown'}`,
    attempts: [withCmr, withoutCmr],
  };
}

/* ---------------------------- candidate selection -------------------------- */

function pickBestPayloadCandidate(candidates: PayloadCandidate[], codec: string): PayloadCandidate | null {
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
          } else {
            ok = decodedLen >= 10;
          }
        } catch {
          ok = false;
        }
      }

      return { c, base64ish, ok, decodedLen, strLen: trimmed.length };
    })
    .filter((x) => x.base64ish)
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (b.decodedLen !== a.decodedLen) return b.decodedLen - a.decodedLen;
      return b.strLen - a.strLen;
    });

  return scored[0]?.c ?? null;
}

/* --------------------------------- codec ---------------------------------- */

function normalizeCodec(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!normalized) return 'AMR-WB';

  if (normalized === 'AMRWB' || normalized === 'AMR_WB') return 'AMR-WB';
  return normalized;
}

export function normalizeTelnyxTrack(track?: string | null): string {
  const normalized = typeof track === 'string' ? track.trim().toLowerCase() : '';
  if (normalized === 'inbound_track') return 'inbound';
  if (normalized === 'outbound_track') return 'outbound';
  return normalized;
}

/* --------------------------------- stats ---------------------------------- */

function computePcmStats(samples: Int16Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = (samples[i] ?? 0) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSquares += s * s;
  }
  return { rms: Math.sqrt(sumSquares / samples.length), peak };
}

/* ------------------------------ capture state ------------------------------ */

function shouldStartCapture(callControlId: string): boolean {
  if (captureConsumed) return false;
  const target = telnyxCaptureCallId();
  if (target) return target === callControlId;
  if (!telnyxCaptureOnceEnabled()) return false;
  if (!captureActiveCallId) captureActiveCallId = callControlId;
  return captureActiveCallId === callControlId;
}

type TelnyxMediaCaptureState = {
  callControlId: string;
  captureId: string;
  ndjsonPath: string;
  dir: string;
  firstEventMs: number;
  startedAtMs?: number;
  endAtMs?: number;
  frameCount: number;
  tinyPayloadFrames: number;
  notAudioFrames: number;
  eventCounts: Record<string, number>;
  payloadLenBuckets: Record<string, number>;
  decodedLenBuckets: Record<string, number>;
  payloadSources: Set<string>;
  payloadSourceCounts: Record<string, number>;
  trackCombos: Set<string>;
  payloadBase64Frames: number;
  payloadNotBase64Frames: number;
  mediaExamples: Array<Record<string, unknown>>;
  stopped?: boolean;
};

function initCaptureState(callControlId: string): TelnyxMediaCaptureState | null {
  if (!shouldStartCapture(callControlId)) return null;
  const dir = telnyxDebugDir();
  const captureId = `${callControlId}_${Date.now()}`;
  const ndjsonPath = path.join(dir, `telnyx_media_capture_${captureId}.ndjson`);
  void fs.promises.mkdir(dir, { recursive: true });

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
    payloadSources: new Set<string>(),
    payloadSourceCounts: {},
    trackCombos: new Set<string>(),
    payloadBase64Frames: 0,
    payloadNotBase64Frames: 0,
    mediaExamples: [],
  };
}

async function appendCaptureRecord(capture: TelnyxMediaCaptureState, record: Record<string, unknown>): Promise<void> {
  try {
    await fs.promises.appendFile(capture.ndjsonPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    log.warn(
      { event: 'media_capture_write_failed', call_control_id: capture.callControlId, err: error },
      'media capture write failed',
    );
  }
}

async function dumpCaptureFrame(
  capture: TelnyxMediaCaptureState,
  callControlId: string,
  seq: number,
  payloadBase64: string,
): Promise<void> {
  const base = path.join(capture.dir, `capture_${callControlId}_${seq}_${Date.now()}`);
  try {
    const decoded = decodeTelnyxPayloadWithInfo(payloadBase64);
    const rawBuf = decoded.buffer;
    const rawPrefixHex = rawBuf.subarray(0, 32).toString('hex');

    await fs.promises.writeFile(`${base}.raw.bin`, rawBuf);
    await fs.promises.writeFile(`${base}.raw_prefix.hex`, rawPrefixHex);
    await fs.promises.writeFile(`${base}.raw_len.txt`, String(rawBuf.length));
    await fs.promises.writeFile(`${base}.raw_encoding.txt`, decoded.encoding);
  } catch (error) {
    log.warn({ event: 'media_capture_dump_failed', call_control_id: callControlId, err: error }, 'media capture dump failed');
  }
}

async function dumpCaptureDecodedPcm(
  capture: TelnyxMediaCaptureState,
  callControlId: string,
  seq: number,
  decodedBuf: Buffer,
): Promise<void> {
  const base = path.join(capture.dir, `capture_${callControlId}_${seq}_${Date.now()}`);
  try {
    const decodedPrefixHex = decodedBuf.subarray(0, 32).toString('hex');
    await fs.promises.writeFile(`${base}.decoded.pcm`, decodedBuf);
    await fs.promises.writeFile(`${base}.decoded_prefix.hex`, decodedPrefixHex);
    await fs.promises.writeFile(`${base}.decoded_len.txt`, String(decodedBuf.length));
  } catch (error) {
    log.warn(
      { event: 'media_capture_decoded_dump_failed', call_control_id: callControlId, err: error },
      'media capture decoded dump failed',
    );
  }
}

async function dumpTelnyxRawPayload(callControlId: string, payload: string): Promise<void> {
  if (!telnyxTapRawEnabled()) return;
  const dir = telnyxDebugDir();
  const base = path.join(dir, `telnyx_raw_${callControlId}_${Date.now()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });

    const decoded = decodeTelnyxPayloadWithInfo(payload);
    const rawBuf = decoded.buffer;
    const rawPrefixHex = rawBuf.subarray(0, 32).toString('hex');

    await fs.promises.writeFile(`${base}.raw.bin`, rawBuf);
    await fs.promises.writeFile(`${base}.raw_prefix.hex`, rawPrefixHex);
    await fs.promises.writeFile(`${base}.raw_len.txt`, String(rawBuf.length));
    await fs.promises.writeFile(`${base}.raw_encoding.txt`, decoded.encoding);
    await fs.promises.writeFile(`${base}.txt`, decoded.trimmed);
  } catch (error) {
    log.warn({ event: 'telnyx_raw_dump_failed', call_control_id: callControlId, err: error }, 'telnyx raw dump failed');
  }
}

async function dumpTelnyxDecodedPcm(callControlId: string, seq: number, decodedBuf: Buffer): Promise<void> {
  if (!telnyxTapRawEnabled()) return;
  const dir = telnyxDebugDir();
  const base = path.join(dir, `telnyx_decoded_${callControlId}_${seq}_${Date.now()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const decodedPrefixHex = decodedBuf.subarray(0, 32).toString('hex');
    await fs.promises.writeFile(`${base}.decoded.pcm`, decodedBuf);
    await fs.promises.writeFile(`${base}.decoded_prefix.hex`, decodedPrefixHex);
    await fs.promises.writeFile(`${base}.decoded_len.txt`, String(decodedBuf.length));
  } catch (error) {
    log.warn(
      { event: 'telnyx_decoded_dump_failed', call_control_id: callControlId, err: error },
      'telnyx decoded dump failed',
    );
  }
}

function summarizeCapture(capture: TelnyxMediaCaptureState, reason: string): void {
  const expectedTrack = normalizeTelnyxTrack(process.env.TELNYX_STREAM_TRACK);
  const trackCombos = Array.from(capture.trackCombos);
  const payloadSources = Array.from(capture.payloadSources);
  const likelyCauses: string[] = [];

  if (expectedTrack && trackCombos.some((combo) => !combo.includes(`media:${expectedTrack}`))) {
    likelyCauses.push('track_mismatch');
  }
  if (capture.payloadNotBase64Frames > 0) likelyCauses.push('payload_not_base64');
  if (capture.notAudioFrames > 0) likelyCauses.push('decoded_len_too_small');
  if (capture.tinyPayloadFrames >= TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT) likelyCauses.push('payload_len_too_small');

  log.info(
    {
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
    },
    'media capture summary',
  );
}

function finalizeCapture(capture: TelnyxMediaCaptureState, reason: string): void {
  if (capture.stopped) return;
  capture.stopped = true;
  captureConsumed = true;
  if (captureActiveCallId === capture.callControlId) captureActiveCallId = null;
  summarizeCapture(capture, reason);
}

/* ------------------------------ health monitor ----------------------------- */

export class MediaIngestHealthMonitor {
  private startedAtMs?: number;
  private endAtMs?: number;
  private totalFrames = 0;
  private decodedFrames = 0;
  private silentFrames = 0;
  private emittedChunks = 0;
  private rollingRmsWindow: number[] = [];
  private rollingRmsSum = 0;
  private rollingRms = 0;
  private tinyPayloadFrames = 0;
  private decodeFailures = 0;
  private lastRms = 0;
  private lastPeak = 0;
  private disabled = false;
  private evaluated = false;

  public start(now: number): void {
    if (this.disabled) return;
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

  public disable(): void {
    this.disabled = true;
  }

  public recordPayload(payloadLen: number, decodedLen: number, rms: number, peak: number, decodeOk: boolean): void {
    if (this.disabled) return;

    // referenced to satisfy noUnusedParameters builds in some configs
    void payloadLen;
    void rms;
    void peak;

    this.totalFrames += 1;
    if (!decodeOk) {
      this.decodeFailures += 1;
    } else {
      this.decodedFrames += 1;
    }
    if (decodedLen < DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT) this.tinyPayloadFrames += 1;
  }

  public recordEmittedChunk(rms: number, peak: number): void {
    if (this.disabled) return;
    this.emittedChunks += 1;
    if (rms < DEFAULT_HEALTH_RMS_FLOOR) this.silentFrames += 1;
    this.lastRms = rms;
    this.lastPeak = peak;

    this.rollingRmsWindow.push(rms);
    this.rollingRmsSum += rms;
    if (this.rollingRmsWindow.length > DEFAULT_HEALTH_MIN_EMIT_CHUNKS) {
      const removed = this.rollingRmsWindow.shift();
      if (removed !== undefined) this.rollingRmsSum -= removed;
    }
    this.rollingRms = this.rollingRmsWindow.length ? this.rollingRmsSum / this.rollingRmsWindow.length : 0;
  }

  public evaluate(now: number): MediaIngestUnhealthyReason | null {
    if (this.disabled || this.evaluated) return null;
    if (!this.startedAtMs || !this.endAtMs) return null;

    const windowElapsed = now >= this.endAtMs;
    const enoughFrames = this.totalFrames >= DEFAULT_HEALTH_MIN_FRAMES;
    if (!windowElapsed || !enoughFrames) return null;

    this.evaluated = true;

    if (this.decodeFailures >= DEFAULT_HEALTH_DECODE_FAILURE_LIMIT) return 'decode_failures';
    if (this.tinyPayloadFrames >= DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT) return 'tiny_payloads';
    if (this.emittedChunks >= DEFAULT_HEALTH_MIN_EMIT_CHUNKS && this.rollingRms < DEFAULT_HEALTH_RMS_FLOOR) {
      return 'low_rms';
    }

    return null;
  }

  public getStats(): {
    totalFrames: number;
    decodedFrames: number;
    silentFrames: number;
    emittedChunks: number;
    rollingRms: number;
    tinyPayloadFrames: number;
    decodeFailures: number;
    lastRms: number;
    lastPeak: number;
  } {
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

/* --------------------------------- ingest --------------------------------- */


export class MediaIngest {

    // ---- reprompt suppression ----
  private lastGoodDecodedAtMs = 0;      // set whenever we successfully decode audio / emit a frame
  private lastRepromptAtMs = 0;         // throttle reprompts

  // tuning knobs (safe defaults)
  private readonly repromptCooldownMs = 5000;          // don't reprompt more often than this
  private readonly repromptSpeechGraceMs = 1500;       // don't reprompt right after speech starts
  private readonly repromptRequireNoGoodAudioMs = 1200; // only reprompt if we've had no good audio recently

  private readonly callControlId: string;
  private readonly transportMode: TransportMode;
  private readonly expectedTrack?: string;
  private readonly acceptCodecs: Set<string>;
  private readonly targetSampleRateHz: number;
  private readonly allowAmrWb: boolean;
  private readonly allowG722: boolean;
  private readonly allowOpus: boolean;
  private readonly logContext?: Record<string, unknown>;
  private readonly onFrame: (frame: MediaIngestFrame) => void;
  private readonly onRestartStreaming?: (codec: string, reason: MediaIngestUnhealthyReason) => Promise<boolean> | boolean;
  private readonly onReprompt?: (reason: MediaIngestUnhealthyReason) => void;
  private readonly maxRestartAttempts: number;
  private decodeChain: Promise<void> = Promise.resolve();

  private readonly isPlaybackActive?: () => boolean;
  private readonly isListening?: () => boolean;
  private readonly getLastSpeechStartAtMs?: () => number | null;

  private readonly onAcceptedPayload?: (tap: MediaIngestAcceptedPayloadTap) => void;

  private readonly healthMonitor = new MediaIngestHealthMonitor();

  // ✅ AUDIO TAP belongs to MediaIngest
  private readonly audioTap?: DebugAudioTap;
  private tappedFirstDecoded = false;

  private mediaEncoding?: string;
  private mediaSampleRate?: number;
  private mediaChannels?: number;

  private playbackSuppressUntilMs = 0;
  private readonly playbackGuardMs =
  Number.isFinite(Number(process.env.STT_PLAYBACK_GUARD_MS))
    ? Math.max(0, Math.floor(Number(process.env.STT_PLAYBACK_GUARD_MS)))
    : 750; // good default: 400–900ms


  /**
   * ✅ Telnyx PSTN inbound AMR-WB should be treated as Bandwidth-Efficient (BE) as-received.
   * This flag is set at the ingest "policy" layer and enforced downstream in codecDecode.ts.
   */
  private forceAmrWbBe = false;
  private forceAmrWbBeLogged = false;

  private mediaCodecLogged = false;
  private mediaSchemaLogged = false;
  private payloadSourceLogged = false;
  private decodedProbeLogged = false;
  private rawProbeLogged = false;
  private amrwbCaptureParseFailedLogged = false;
  private mediaPayloadDebugCount = 0;

  private activeStreamId: string | null = null;
  private lastSeqByStream = new Map<string, number>();

  private readonly dumpFramesEnabled: boolean;
  private readonly dumpFramesMax: number;
  private readonly dumpFramesDir: string;
  private dumpFramesIndex = 0;
  private dumpFramesDisabled = false;
  private dumpStartLogged = false;
  private dumpErrorLogged = false;

  private readonly amrwbCaptureEnabled: boolean;
  private readonly amrwbCaptureDir: string;
  private amrwbCaptureChain: Promise<void> = Promise.resolve();
  private amrwbCaptureDirReady = false;
  private amrwbCaptureContractWritten = false;
  private amrwbCaptureDisabled = false;
  private amrwbCaptureErrorLogged = false;


  // Optional: hard pin codec to prevent flip-flop (policy)
  private pinnedCodec?: string;

  private frameSeq = 0;
  private captureState?: TelnyxMediaCaptureState;

  private codecState: TelnyxCodecState = {};
  private pendingPcm?: Int16Array;
  private pendingPcmSampleRateHz?: number;
  private readonly emitChunkMs: number;

  private lastStatsLogAt = 0;
  private lastEmitLogAt = 0;
  private amrwbEmitDebugCount = 0;
  private amrwbEmitDebugLastLogAt = 0;
  private restartAttempts = 0;
  private ingestUnhealthyLogged = false;

  private rxFramesInbound = 0;
  private rxFramesOutboundSkipped = 0;
  private rxFramesUnknownTrackSkipped = 0;

  constructor(options: MediaIngestOptions) {
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

    const maxRestartAttempts =
      typeof options.maxRestartAttempts === 'number' && Number.isFinite(options.maxRestartAttempts)
        ? options.maxRestartAttempts
        : 1;
    this.maxRestartAttempts = Math.max(0, maxRestartAttempts);
    this.emitChunkMs = resolveEmitMs();

    this.captureState = initCaptureState(this.callControlId) ?? undefined;
    if (this.captureState) {
      log.info(
        { event: 'media_capture_started', call_control_id: this.callControlId, ndjson: this.captureState.ndjsonPath },
        'media capture started',
      );
    }

    this.dumpFramesEnabled = sttDebugDumpFramesEnabled();
    this.dumpFramesMax = sttDebugDumpCount();
    this.dumpFramesDir = sttDebugDumpDir();
    this.amrwbCaptureEnabled = amrwbTruthCaptureEnabled();
    this.amrwbCaptureDir = path.join(telnyxDebugDir(), this.callControlId);

    // -------------------- AUDIO TAP (debug WAV checkpoints) --------------------
    const tapEnabled =
      process.env.AUDIO_TAP === '1' || process.env.AUDIO_TAP === 'true' || process.env.AUDIO_TAP === 'yes';

    if (tapEnabled) {
      const secondsToKeepRaw = Number(process.env.AUDIO_TAP_SECONDS || 8);
      const secondsToKeep = Number.isFinite(secondsToKeepRaw) && secondsToKeepRaw > 0 ? secondsToKeepRaw : 8;

      this.audioTap = new DebugAudioTap({
        enabled: true,
        baseDir: process.env.AUDIO_TAP_DIR?.trim() || telnyxDebugDir(),
        sessionId: this.callControlId,
        sampleRate: this.targetSampleRateHz, // downstream rate
        channels: 1,
        secondsToKeep,
      });

      log.info(
        {
          event: 'audio_tap_enabled',
          call_control_id: this.callControlId,
          dir: process.env.AUDIO_TAP_DIR?.trim() || telnyxDebugDir(),
          seconds_to_keep: secondsToKeep,
          sample_rate_hz: this.targetSampleRateHz,
        },
        'audio tap enabled',
      );
    }

    log.info(
      {
        event: 'media_ingest_start',
        call_control_id: this.callControlId,
        transport_mode: this.transportMode,
        expected_track: this.expectedTrack || undefined,
        target_sample_rate_hz: this.targetSampleRateHz,
        accept_codecs: Array.from(this.acceptCodecs),
        ...(this.logContext ?? {}),
      },
      'media ingest start',
    );
  }

  private shouldFireReprompt(reason: MediaIngestUnhealthyReason): boolean {
    void reason;
    const now = Date.now();

    // Only reprompt if we are in LISTENING mode (if hook is provided)
    if (this.isListening && !this.isListening()) return false;

    // Never reprompt during playback (greeting / TTS)
    if (this.isPlaybackActive && this.isPlaybackActive()) return false;

    // Cooldown to prevent spam
    if (this.lastRepromptAtMs && now - this.lastRepromptAtMs < this.repromptCooldownMs) return false;

    // If speech just started, don't reprompt
    const lastSpeechStart = this.getLastSpeechStartAtMs ? this.getLastSpeechStartAtMs() ?? 0 : 0;
    if (lastSpeechStart && now - lastSpeechStart < this.repromptSpeechGraceMs) return false;

    // If we decoded good audio recently, don't reprompt
    if (this.lastGoodDecodedAtMs && now - this.lastGoodDecodedAtMs < this.repromptRequireNoGoodAudioMs) return false;

    return true;
  }



  public handleBinary(buffer: Buffer): void {
    if (buffer.length === 0) return;
    this.handleEncodedPayload(buffer, undefined, undefined, 'binary');
  }

  public handleMessage(message: Record<string, unknown>): void {
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
      } else if (capture.startedAtMs && capture.endAtMs && now > capture.endAtMs) {
        finalizeCapture(capture, 'capture_window_elapsed');
      }
    }

    if (event === 'connected') return;

    if (event === 'start') {
      this.handleStartEvent(message);
      return;
    }

    if (event === 'stop') {
      if (this.captureState && !this.captureState.stopped) finalizeCapture(this.captureState, 'ws_stop');
      return;
    }

    if (event !== 'media') return;

    // -------------------- STREAM ISOLATION (drop old/out-of-order) --------------------
    const msgStreamId = this.getTelnyxStreamId(message);
    const seqNum = this.getTelnyxSequence(message);

    // Adopt if needed
    if (!this.activeStreamId && msgStreamId) {
      this.activeStreamId = msgStreamId;
      this.lastSeqByStream.set(msgStreamId, -1);
      log.info(
        { event: 'telnyx_stream_adopted', call_control_id: this.callControlId, stream_id: msgStreamId, ...(this.logContext ?? {}) },
        'adopted Telnyx stream_id from media frame',
      );
    }

    // Drop old stream frames
    if (this.activeStreamId && msgStreamId && msgStreamId !== this.activeStreamId) {
      log.warn(
        {
          event: 'telnyx_stream_old_frame_dropped',
          call_control_id: this.callControlId,
          stream_id: msgStreamId,
          active_stream_id: this.activeStreamId,
          ...(this.logContext ?? {}),
        },
        'dropping media frame from old Telnyx stream_id (restart overlap defense)',
      );
      return;
    }

    // Seq guard: CHECK now, but DO NOT COMMIT lastSeq until after we decide to keep the frame.
    let shouldCommitSeq = false;
    if (this.activeStreamId && typeof seqNum === 'number' && Number.isFinite(seqNum)) {
      const last = this.lastSeqByStream.get(this.activeStreamId) ?? -1;
      if (seqNum <= last) {
        log.warn(
          {
            event: 'telnyx_seq_dup_or_reorder_dropped',
            call_control_id: this.callControlId,
            stream_id: this.activeStreamId,
            seq: seqNum,
            last_seq: last,
            ...(this.logContext ?? {}),
          },
          'dropping duplicate/out-of-order Telnyx media frame by sequence_number',
        );
        return;
      }
      shouldCommitSeq = true;
    }
    // -------------------------------------------------------------------------------


    const media = message.media && typeof message.media === 'object' ? (message.media as Record<string, unknown>) : undefined;
    const mediaData = media?.data && typeof media.data === 'object' ? (media.data as Record<string, unknown>) : undefined;

    const payloadCandidates: PayloadCandidate[] = [];
    const mediaPayload = this.getString(media?.payload);
    if (mediaPayload) payloadCandidates.push({ source: 'media.payload', value: mediaPayload });
    const mediaDataPayload = this.getString(mediaData?.payload);
    if (mediaDataPayload) payloadCandidates.push({ source: 'media.data.payload', value: mediaDataPayload });
    const mediaDataString = this.getString(media?.data);
    if (mediaDataString) payloadCandidates.push({ source: 'media.data', value: mediaDataString });
    const topPayload = this.getString(message.payload);
    if (topPayload) payloadCandidates.push({ source: 'payload', value: topPayload });

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

    const trackFields: TrackFields = {
      mediaTrack: this.getString(media?.track),
      msgTrack: this.getString(message.track),
      streamTrack: this.getString(message.stream_track),
      dataTrack: this.getString(mediaData?.track),
    };

    const resolvedTrack = trackFields.mediaTrack ?? trackFields.msgTrack ?? trackFields.dataTrack ?? trackFields.streamTrack;
    const normalizedTrack = normalizeTelnyxTrack(resolvedTrack);

    if (mediaSchemaDebugEnabled() && !this.mediaSchemaLogged) {
      this.mediaSchemaLogged = true;
      log.info(
        {
          event: 'media_schema',
          call_control_id: this.callControlId,
          top_level_keys: Object.keys(message),
          media_keys: media ? Object.keys(media) : null,
          has_media_payload: typeof media?.payload === 'string',
          media_payload_len: typeof media?.payload === 'string' ? (media.payload as string).length : null,
          has_top_payload: typeof message.payload === 'string',
          top_payload_len: typeof message.payload === 'string' ? (message.payload as string).length : null,
          possible_alt_paths: {
            media_data_keys: mediaData ? Object.keys(mediaData) : null,
            media_data_payload_type: typeof mediaData?.payload === 'string' ? 'string' : typeof mediaData?.payload,
            media_data_payload_len: typeof mediaData?.payload === 'string' ? (mediaData.payload as string).length : null,
          },
          track_fields: {
            media_track: media?.track,
            msg_track: message.track,
            stream_track: message.stream_track,
            data_track: mediaData?.track,
          },
          timestamp: typeof media?.timestamp === 'number' ? media.timestamp : null,
        },
        'media schema',
      );
    }

    if (!this.payloadSourceLogged) {
      this.payloadSourceLogged = true;
      log.info(
        {
          event: 'media_payload_source',
          call_control_id: this.callControlId,
          payload_source: payloadSource,
          payload_len: payload.trim().length,
          codec: currentCodec,
          track: resolvedTrack ?? null,
          ...(this.logContext ?? {}),
        },
        'media payload source selected',
      );
    }

    // --------------------------------------------------------------------------------
    // Prefer Telnyx seq if present; fall back to a local monotonic counter.
    // IMPORTANT: do NOT bump local counter until we know we’re keeping the frame.
    // --------------------------------------------------------------------------------
    const telnyxSeq = seqNum; // already computed above via getTelnyxSequence(message)
    const seqForPipeline = typeof telnyxSeq === 'number' && Number.isFinite(telnyxSeq) ? telnyxSeq : undefined;

    // We still keep a local counter for when Telnyx seq is missing.
    // NOTE: we will assign it later (after gating) only if needed.
    let localSeqAssigned: number | undefined;

    // --------------------------------------------------------------
    // decode base64 -> bytes (NO hashing yet)
    // --------------------------------------------------------------
    let buffer: Buffer;
    let encodingUsed: Base64Encoding = 'base64';
    let trimmedPayload = payload.trim();
    const payloadLooksBase64 = looksLikeBase64(trimmedPayload);
    const base64Len = trimmedPayload.length;

    try {
      const decoded = decodeTelnyxPayloadWithInfo(trimmedPayload);
      buffer = decoded.buffer;
      encodingUsed = decoded.encoding;
      trimmedPayload = decoded.trimmed;
    } catch (error) {
      // 4th arg = seq (if we have Telnyx seq already), 5th arg = note
      this.logMediaPayloadDebug(base64Len, null, payloadSource, seqForPipeline, 'decode_failed');
      log.warn(
        { event: 'media_ws_decode_failed', call_control_id: this.callControlId, err: error },
        'media ws decode failed',
      );
      return;
    }


    // NOTE: currentCodec was already computed earlier (do NOT redeclare it here).
    // Use the existing variable that was used for candidate selection.
    // const currentCodec = normalizeCodec(this.mediaEncoding);

    // basic "decoded bytes too short" gate (same as your existing logic)
    const minDecodedLen = currentCodec === 'AMR-WB' ? 6 : 10;
    if (buffer.length < minDecodedLen) {
      log.info(
        {
          event: 'media_payload_suspicious',
          call_control_id: this.callControlId,
          codec: currentCodec,
          payload_len: trimmedPayload.length,
          decoded_len: buffer.length,
          payload_source: payloadSource,
          telnyx_seq: seqForPipeline ?? null,
          ...(this.logContext ?? {}),
        },
        'media payload too short',
      );
      this.healthMonitor.recordPayload(trimmedPayload.length, buffer.length, 0, 0, false);
      this.checkHealth(currentCodec);
      return;
    }

    // track gating FIRST (so outbound frames never enter dedupe or decode path)
    if (this.expectedTrack && this.expectedTrack !== 'both_tracks' && normalizedTrack && this.expectedTrack !== normalizedTrack) {
      if (normalizedTrack === 'outbound') this.rxFramesOutboundSkipped += 1;
      else this.rxFramesUnknownTrackSkipped += 1;

      log.info(
        {
          event: 'media_track_skipped',
          call_control_id: this.callControlId,
          expected_track: this.expectedTrack,
          got_track: normalizedTrack,
          telnyx_seq: seqForPipeline ?? null,
          bytes: buffer.length,
          ...(this.logContext ?? {}),
        },
        'media track skipped',
      );
      return;
    }

    // -------------------- PLAYBACK ECHO GUARD --------------------
    // Suppress non-inbound tracks during playback to avoid echoing TTS into STT.
    // Also keep a short grace window after playback ends to avoid jitter-delivered frames.
    const nowMs = Date.now();
    const playbackActive = this.isPlaybackActive?.() === true;
    const allowInboundDuringPlayback = normalizedTrack === 'inbound';

    if (playbackActive && !allowInboundDuringPlayback) {
      this.playbackSuppressUntilMs = nowMs + this.playbackGuardMs;

      if (capture && !capture.stopped) {
        void appendCaptureRecord(capture, {
          ts: new Date().toISOString(),
          call_control_id: this.callControlId,
          ws_event: 'media',
          kind: 'media_dropped',
          reason: 'playback_active',
          seq: seqForPipeline ?? null,
        });
      }

      // ✅ IMPORTANT: do not commit seq for dropped frames
      return;
    }

    if (!allowInboundDuringPlayback && nowMs < this.playbackSuppressUntilMs) {
      if (capture && !capture.stopped) {
        void appendCaptureRecord(capture, {
          ts: new Date().toISOString(),
          call_control_id: this.callControlId,
          ws_event: 'media',
          kind: 'media_dropped',
          reason: 'post_playback_grace',
          suppress_until_ms: this.playbackSuppressUntilMs,
          seq: seqForPipeline ?? null,
        });
      }

      // ✅ IMPORTANT: do not commit seq for dropped frames
      return;
    }
    // -------------------------------------------------------------

    // ✅ Commit Telnyx seq ONLY after we fully accept the frame (post-track + post-playback gates)
    if (shouldCommitSeq && this.activeStreamId && typeof seqNum === 'number' && Number.isFinite(seqNum)) {
      this.lastSeqByStream.set(this.activeStreamId, seqNum);
    }




    if (normalizedTrack === 'inbound') this.rxFramesInbound += 1;

    // Assign local seq only after we know we’re keeping the frame.
    if (seqForPipeline === undefined) {
      this.frameSeq += 1;
      localSeqAssigned = this.frameSeq;
    }

    // Canonical seq used everywhere downstream.
    const finalSeq = seqForPipeline ?? (localSeqAssigned as number);


    
    // --------------------------------------------------------------------------
    // From this point on, ALWAYS use finalSeq (not this.frameSeq)
    // --------------------------------------------------------------------------

    void this.maybeDumpMediaFrame(trimmedPayload, buffer);
    
    this.queueAmrwbTruthCapture(buffer, finalSeq);

    this.logMediaPayloadDebug(base64Len, buffer, payloadSource, finalSeq);


    void dumpTelnyxRawPayload(this.callControlId, trimmedPayload);

    if (capture && !capture.stopped) {
      const payloadLen = trimmedPayload.length;
      capture.frameCount += 1;
      const isTinyForCapture = currentCodec === 'AMR-WB' ? buffer.length < 6 : payloadLen < TELNYX_CAPTURE_TINY_PAYLOAD_LEN;

      if (isTinyForCapture) capture.tinyPayloadFrames += 1;

      if (payloadLooksBase64) capture.payloadBase64Frames += 1;
      else capture.payloadNotBase64Frames += 1;

      capture.payloadSources.add(payloadSource);
      capture.payloadSourceCounts[payloadSource] = (capture.payloadSourceCounts[payloadSource] ?? 0) + 1;

      incrementBucket(capture.payloadLenBuckets, payloadLen);
      incrementBucket(capture.decodedLenBuckets, buffer.length);

      const trackCombo = `media:${normalizeTelnyxTrack(trackFields.mediaTrack)}|msg:${normalizeTelnyxTrack(
        trackFields.msgTrack,
      )}|stream:${normalizeTelnyxTrack(trackFields.streamTrack)}|data:${normalizeTelnyxTrack(trackFields.dataTrack)}`;
      capture.trackCombos.add(trackCombo);

      const payloadPrefix = redactInline(trimmedPayload.slice(0, 64));
      const decodedPrefixHex = buffer.subarray(0, 32).toString('hex');
      const timestamp = typeof media?.timestamp === 'number' ? (media.timestamp as number) : undefined;

      const notAudio = currentCodec === 'AMR-WB' ? buffer.length < 20 : buffer.length < 10;
      if (notAudio) capture.notAudioFrames += 1;

      const shouldParseOctetAligned =
        currentCodec === 'AMR-WB' &&
        this.transportMode !== 'pstn' && // PSTN = BE in our system
        !this.forceAmrWbBe &&
        buffer.length >= 2;


      const amrwbParse = shouldParseOctetAligned
        ? debugParseAmrWbPayload(buffer)
        : null;

      if (!amrwbParse?.ok && amrwbParse && !this.amrwbCaptureParseFailedLogged) {
        this.amrwbCaptureParseFailedLogged = true;
        log.warn(
          {
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
          },
          'amr-wb capture parse failed',
        );
      }

      if (capture.mediaExamples.length < 2) capture.mediaExamples.push(sanitizeForCapture(message) as Record<string, unknown>);

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
      } else if (capture.tinyPayloadFrames >= TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT && currentCodec !== 'AMR-WB') {
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
        timestamp: typeof media?.timestamp === 'number' ? (media.timestamp as number) : null,
        payloadSource: payloadSource ?? null,
        payloadLen: trimmedPayload.length,
        decodedLen: buffer.length,
        hexPrefix: buffer.subarray(0, 24).toString('hex'),
        playbackActive: this.isPlaybackActive?.() ?? false,
        listening: this.isListening?.() ?? false,
        lastSpeechStartAtMs: this.getLastSpeechStartAtMs?.() ?? null,
      });
    } catch (error) {
      log.warn(
        {
          event: 'media_ingest_onAcceptedPayload_failed',
          call_control_id: this.callControlId,
          err: error,
          ...(this.logContext ?? {}),
        },
        'media ingest onAcceptedPayload hook failed',
      );
    }

    // decode pipeline: use finalSeq
    this.handleEncodedPayload(
      buffer,
      typeof media?.timestamp === 'number' ? (media.timestamp as number) : undefined,
      finalSeq,
      payloadSource,
    );

  }

  public close(reason: string): void {
    if (this.captureState && !this.captureState.stopped) finalizeCapture(this.captureState, reason);
    this.decodeChain = this.decodeChain
      .then(() => this.flushPendingPcm(reason))
      .catch((err: unknown) => {
        log.warn(
          { event: 'media_ingest_flush_pending_failed', call_control_id: this.callControlId, err, ...(this.logContext ?? {}) },
          'media ingest flush pending failed',
        );
      })
      .then(() => {
        closeTelnyxCodecState(this.codecState);
      });
  }

  /* --------------------------- AMR-WB BE truth capture -------------------------- */


  // AMR-WB storage (AWB) frames are: [1-byte frame header] + [speech bytes]
  // Telnyx BE RTP single-frame payloads are: [1-byte TOC] + [speech bytes]

  private async ensureAmrwbContractFile(): Promise<void> {
    if (this.amrwbCaptureContractWritten) return;
    const contractPath = path.join(this.amrwbCaptureDir, 'amrwb_contract.txt');
    try {
      await fs.promises.writeFile(contractPath, AMRWB_CONTRACT_TEXT, { flag: 'wx' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST') {
        log.warn(
          { event: 'amrwb_contract_write_failed', call_control_id: this.callControlId, err, ...(this.logContext ?? {}) },
          'amrwb contract write failed',
        );
      }
    } finally {
      this.amrwbCaptureContractWritten = true;
    }
  }



  private logAmrwbCaptureErrorOnce(error: unknown, note: string): void {
    if (this.amrwbCaptureErrorLogged) return;
    this.amrwbCaptureErrorLogged = true;
    log.warn(
      { event: 'amrwb_truth_capture_error', call_control_id: this.callControlId, note, err: error, ...(this.logContext ?? {}) },
      'amrwb truth capture failed',
    );
  }

  private queueAmrwbTruthCapture(payload: Buffer, frameIndex: number): void {
    if (!this.amrwbCaptureEnabled || this.amrwbCaptureDisabled) return;
    this.amrwbCaptureChain = this.amrwbCaptureChain
      .then(() => this.captureAmrwbTruthPayload(payload, frameIndex))
      .catch((error) => {
        this.amrwbCaptureDisabled = true;
        this.logAmrwbCaptureErrorOnce(error, 'capture');
      });
  }

  private async captureAmrwbTruthPayload(payload: Buffer, frameIndex: number): Promise<void> {
    if (!this.amrwbCaptureEnabled || this.amrwbCaptureDisabled) return;

    if (!this.amrwbCaptureDirReady) {
      try {
        await fs.promises.mkdir(this.amrwbCaptureDir, { recursive: true });
      } catch (error) {
        this.amrwbCaptureDisabled = true;
        this.logAmrwbCaptureErrorOnce(error, 'mkdir');
        return;
      }
      this.amrwbCaptureDirReady = true;
    }

    await this.ensureAmrwbContractFile();

    const rawPath = path.join(this.amrwbCaptureDir, 'raw_frames.lenbin');

    try {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(payload.length, 0);
      await fs.promises.appendFile(rawPath, Buffer.concat([lenBuf, payload]));
    } catch (error) {
      this.amrwbCaptureDisabled = true;
      this.logAmrwbCaptureErrorOnce(error, 'write_raw');
      return;
    }

    // Decide what we think this payload is (policy-based)
    const payloadMode: 'be' | 'octet' = this.transportMode === 'pstn' || this.forceAmrWbBe ? 'be' : 'octet';

    // Only run the “single-frame octet-aligned” classifier when we’re in octet mode.
    // For BE payloads this classifier is not meaningful.
    const single = payloadMode === 'octet' ? classifyAmrwbSingleFrame(payload) : null;

    const first8Hex = getHexPrefix(payload, 8);

    log.info(
      {
        event: 'amrwb_truth_capture_frame',
        call_control_id: this.callControlId,
        frame_index: frameIndex,
        payload_len: payload.length,
        first8_hex: first8Hex,

        payload_mode: payloadMode,

        // only meaningful when payload_mode === 'octet'
        single_frame_ok: single?.ok ?? null,
        single_frame_reason: single?.reason ?? null,
        single_toc: single?.toc ?? null,
        single_ft: single?.ft ?? null,
        single_q: typeof single?.q === 'boolean' ? single.q : null,
        single_expected_bytes: single?.expectedBytes ?? null,

        appended_streams: { raw: true },
        be_output_disabled: true,
        ...(this.logContext ?? {}),
      },
      'amrwb truth capture...',
    );
  }

  /* ------------------------------ low-level helpers ----------------------------- */

  private getTelnyxStreamId(message: Record<string, unknown>): string | undefined {
    const media = message.media && typeof message.media === 'object' ? (message.media as Record<string, unknown>) : undefined;
    const start = message.start && typeof message.start === 'object' ? (message.start as Record<string, unknown>) : undefined;

    return (
      this.getString(message.stream_id) ||
      this.getString(message.streamId) ||
      this.getString(media?.stream_id) ||
      this.getString(media?.streamId) ||
      this.getString(start?.stream_id) ||
      this.getString(start?.streamId)
    );
  }

  private getTelnyxSequence(message: Record<string, unknown>): number | undefined {
    const media = message.media && typeof message.media === 'object' ? (message.media as Record<string, unknown>) : undefined;
    const mediaData = media?.data && typeof media.data === 'object' ? (media.data as Record<string, unknown>) : undefined;

    return (
      this.getNumber(message.sequence_number) ??
      this.getNumber(message.sequenceNumber) ??
      this.getNumber(media?.sequence_number) ??
      this.getNumber(media?.sequenceNumber) ??
      this.getNumber(mediaData?.sequence_number) ??
      this.getNumber(mediaData?.sequenceNumber)
    );
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }

  private getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /* ------------------------------ dump frames ----------------------------- */

  private dumpFramesActive(): boolean {
    return this.dumpFramesEnabled && !this.dumpFramesDisabled;
  }

  private dumpFramesDirForCall(): string {
    const token = this.callControlId ? safeFileToken(this.callControlId) : `session_${Date.now()}`;
    return path.join(this.dumpFramesDir, token);
  }

  private logDumpErrorOnce(error: unknown, note: string): void {
    if (this.dumpErrorLogged) return;
    this.dumpErrorLogged = true;
    log.warn(
      { event: 'media_dump_error', call_control_id: this.callControlId, note, err: error, ...(this.logContext ?? {}) },
      'media dump failed',
    );
  }

private guessDumpKind(raw: Buffer): 'wav_riff' | 'unknown' {
  if (looksLikeWavRiff(raw)) return 'wav_riff';
  return 'unknown';
}



  private maybeDumpStartEvent(message: Record<string, unknown>): void {
    if (!this.dumpFramesActive() || this.dumpStartLogged) return;
    this.dumpStartLogged = true;
    const dir = this.dumpFramesDirForCall();
    const sanitized = sanitizeForCapture(message);

    void fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => fs.promises.writeFile(path.join(dir, 'telnyx_start.json'), `${JSON.stringify(sanitized, null, 2)}\n`))
      .catch((error) => this.logDumpErrorOnce(error, 'start_event'));

    log.info(
      { event: 'telnyx_start_dump', call_control_id: this.callControlId, start: sanitized, ...(this.logContext ?? {}) },
      'telnyx start event (sanitized)',
    );
  }

  private async maybeDumpMediaFrame(base64Payload: string, raw: Buffer): Promise<void> {
    if (!this.dumpFramesActive()) return;
    if (this.dumpFramesIndex >= this.dumpFramesMax) return;

    const idx = this.dumpFramesIndex + 1;
    this.dumpFramesIndex = idx;

    const dir = this.dumpFramesDirForCall();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (error) {
      this.dumpFramesDisabled = true;
      this.logDumpErrorOnce(error, 'mkdir');
      return;
    }

    const padded = String(idx).padStart(4, '0');
    const basePath = path.join(dir, `frame_${padded}`);
    const rawHex16 = getHexPrefix(raw, 16); 

    const guessedKind = this.guessDumpKind(raw);

    let prepared: Buffer | null = null;
    let preparedHex16: string | null = null;

    // If this call is AMR-WB, try prepare on the raw bytes regardless of “magic header”
    if (normalizeCodec(this.mediaEncoding) === 'AMR-WB') {
      const prep = prepareAmrWbPayload(raw);
      prepared = prep.prepared ?? null;
      preparedHex16 = prepared ? getHexPrefix(prepared, 16) : null;
    }


    try {
      await fs.promises.writeFile(`${basePath}.b64.txt`, base64Payload);
      await fs.promises.writeFile(`${basePath}.raw.bin`, raw);
      if (prepared) {
        await fs.promises.writeFile(`${basePath}.prepared.bin`, prepared);
      }
    } catch (error) {
      this.dumpFramesDisabled = true;
      this.logDumpErrorOnce(error, 'write');
      return;
    }

    log.info(
      {
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
      },
      `[MEDIA_DUMP] idx=${idx} b64Len=${base64Payload.length} rawLen=${raw.length} rawHex16=${rawHex16} preparedLen=${
        prepared?.length ?? 'n/a'
      } preparedHex16=${preparedHex16 ?? 'n/a'} guessedKind=${guessedKind}`,
    );
  }

  /* ------------------------------ policy: force BE ----------------------------- */

  private maybeEnableForceBe(encoding: string, source: 'start' | 'defaulted' | 'payload'): void {
    if (this.forceAmrWbBe) return;
    if (this.transportMode !== 'pstn') return;
    if (encoding !== 'AMR-WB') return;

    this.forceAmrWbBe = true;

    if (!this.forceAmrWbBeLogged) {
      this.forceAmrWbBeLogged = true;
      log.info(
        {
          event: 'amrwb_force_be_enabled',
          call_control_id: this.callControlId,
          transport_mode: this.transportMode,
          codec: encoding,
          source,
          ...(this.logContext ?? {}),
        },
        'forcing AMR-WB Bandwidth-Efficient (BE) decode for Telnyx PSTN (no CMR strip / no repack)',
      );
    }
  }

  /* ------------------------------ start event ----------------------------- */

  private handleStartEvent(message: Record<string, unknown>): void {
    this.maybeDumpStartEvent(message);

    const start = message.start && typeof message.start === 'object' ? (message.start as Record<string, unknown>) : {};
    const streamId = this.getString(start.stream_id) ?? this.getString(message.stream_id);

    if (streamId) {
      this.activeStreamId = streamId;
      this.lastSeqByStream.set(streamId, -1);

      log.info(
        { event: 'telnyx_stream_active', call_control_id: this.callControlId, stream_id: streamId, ...(this.logContext ?? {}) },
        'active stream set',
      );
    }

    const mediaFormat =
      (start.media_format as Record<string, unknown> | undefined) ??
      (message.media_format as Record<string, unknown> | undefined) ??
      undefined;

    const encoding = mediaFormat ? this.getString(mediaFormat.encoding) : undefined;

    const sampleRate =
      mediaFormat && typeof mediaFormat.sample_rate === 'number'
        ? (mediaFormat.sample_rate as number)
        : mediaFormat && typeof mediaFormat.sampleRate === 'number'
          ? (mediaFormat.sampleRate as number)
          : undefined;

    const channels = mediaFormat ? this.getNumber(mediaFormat.channels) : undefined;

    let normalizedEncoding = normalizeCodec(encoding ?? this.mediaEncoding);

    // Optional: force PSTN to AMR-WB
    if (
      this.transportMode === 'pstn' &&
      parseBoolEnv(process.env.TELNYX_FORCE_AMRWB_PSTN) &&
      this.allowAmrWb &&
      this.acceptCodecs.has('AMR-WB')
    ) {
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
      log.info(
        {
          event: 'media_ingest_codec_detected',
          call_control_id: this.callControlId,
          codec: normalizedEncoding,
          sample_rate: this.mediaSampleRate,
          channels,
          ...(this.logContext ?? {}),
        },
        'media ingest codec detected',
      );
    }

    this.healthMonitor.start(Date.now());
  }

  private isCodecSupported(codec: string): { supported: boolean; reason?: string } {
    if (!this.acceptCodecs.has(codec)) return { supported: false, reason: 'codec_not_accepted' };
    if (codec === 'AMR-WB' && !this.allowAmrWb) return { supported: false, reason: 'amrwb_decode_disabled' };
    if (codec === 'G722' && !this.allowG722) return { supported: false, reason: 'g722_decode_disabled' };
    if (codec === 'OPUS' && !this.allowOpus) return { supported: false, reason: 'opus_decode_disabled' };
    return { supported: true };
  }

  /* ------------------------------ ingest core ----------------------------- */

  private handleEncodedPayload(buffer: Buffer, timestamp?: number, seq?: number, payloadSource?: string): void {
    if (!this.mediaEncoding) {
      log.warn(
        {
          event: 'media_ingest_codec_defaulted',
          call_control_id: this.callControlId,
          assumed_codec: 'AMR-WB',
          reason: 'mediaEncoding unset (media_format.encoding missing or start not processed yet)',
          payload_len: buffer.length,
          seq,
          timestamp,
          payloadSource,
          ...(this.logContext ?? {}),
        },
        'media ingest codec defaulted (no mediaEncoding set)',
      );
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
      log.warn(
        {
          event: 'media_ingest_codec_unsupported',
          call_control_id: this.callControlId,
          encoding,
          reason: support.reason,
          ...(this.logContext ?? {}),
        },
        'media ingest codec unsupported',
      );
      this.healthMonitor.recordPayload(buffer.length, buffer.length, 0, 0, false);
      this.checkHealth(encoding);
      return;
    }

    if (!this.rawProbeLogged) {
      this.rawProbeLogged = true;

      const meta: AudioMeta = {
        callId: this.callControlId,
        format: encoding === 'PCMU' ? 'pcmu' : encoding === 'PCMA' ? 'alaw' : undefined,
        codec: encoding,
        sampleRateHz: this.mediaSampleRate,
        channels: this.mediaChannels ?? 1,
        bitDepth: encoding === 'PCMU' || encoding === 'PCMA' ? 8 : undefined,
        logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
        lineage: ['rx.telnyx.raw'],
      };

      attachAudioMeta(buffer, meta);
      if (diagnosticsEnabled()) {
        if (encoding === 'PCMU' || encoding === 'PCMA') {
          probePcm('rx.telnyx.raw', buffer, meta);
        } else {
          log.info(
            {
              event: 'audio_probe_skipped',
              call_control_id: this.callControlId,
              encoding,
              sample_rate: this.mediaSampleRate,
              channels: this.mediaChannels ?? 1,
              ...(this.logContext ?? {}),
            },
            'audio probe skipped for non-PCM codec',
          );
        }
      }
      markAudioSpan('rx', meta);
    }

    this.decodeChain = this.decodeChain
      .then(() => this.decodeAndEmit(buffer, encoding, timestamp, seq, payloadSource))
      .catch((err: unknown) => {
        log.warn(
          { event: 'media_ingest_decode_chain_error', call_control_id: this.callControlId, err, ...(this.logContext ?? {}) },
          'media ingest decode chain error',
        );
      });
  }
  

  private flushPendingPcm(reason: string): void {
    if (!this.pendingPcm || this.pendingPcm.length === 0) return;

    const pending = this.pendingPcm;
    const sampleRateHz = this.pendingPcmSampleRateHz ?? this.targetSampleRateHz;
    this.pendingPcm = undefined;
    this.pendingPcmSampleRateHz = undefined;

    this.maybeLogEmitDebug(pending, pending, sampleRateHz, undefined, `flush_${reason}`);

    if (this.audioTap && pending.length > 0) {
      const frameBuf = Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength);
      this.audioTap.push('EMITTED_BUFFERED', frameBuf);
    }

    if (!this.decodedProbeLogged && diagnosticsEnabled()) {
      this.decodedProbeLogged = true;
      const pcmBuffer = Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength);
      const meta: AudioMeta = {
        callId: this.callControlId,
        format: 'pcm16le',
        codec: this.mediaEncoding ?? 'unknown',
        sampleRateHz,
        channels: 1,
        bitDepth: 16,
        logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
        lineage: ['rx.decoded.pcm16'],
      };
      attachAudioMeta(pcmBuffer, meta);
      probePcm('rx.decoded.pcm16', pcmBuffer, meta);
    }

    this.lastGoodDecodedAtMs = Date.now();


    this.onFrame({
      callControlId: this.callControlId,
      pcm16: pending,
      sampleRateHz,
      channels: 1,
    });
  }

  private maybeLogEmitDebug(
    accumulated: Int16Array,
    emitted: Int16Array,
    sampleRateHz: number,
    seq?: number,
    note?: string,
  ): void {
    if (!emitChunkDebugEnabled()) return;
    const now = Date.now();
    if (now - this.lastEmitLogAt < 1000) return;
    this.lastEmitLogAt = now;

    try {
      const accumulatedStats = computePcmStats(accumulated);
      const emittedStats = computePcmStats(emitted);
      const accumulatedMs = Math.round((accumulated.length / sampleRateHz) * 1000);
      const emittedMs = Math.round((emitted.length / sampleRateHz) * 1000);

      log.info(
        {
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
        },
        'media ingest buffered emit',
      );
    } catch (error) {
      log.warn(
        { event: 'media_ingest_emit_debug_failed', call_control_id: this.callControlId, err: error, ...(this.logContext ?? {}) },
        'media ingest emit debug failed',
      );
    }
  }

  private shouldLogAmrwbEmitDebug(now: number): boolean {
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

  private countNearZeroSamples(samples: Int16Array, threshold: number): { zero: number; nearZero: number } {
    let zero = 0;
    let nearZero = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] ?? 0;
      if (value === 0) zero += 1;
      if (Math.abs(value) <= threshold) nearZero += 1;
    }
    return { zero, nearZero };
  }

  private logMediaPayloadDebug(
    base64Len: number,
    buffer: Buffer | null,
    payloadSource: string | undefined,
    seq?: number,
    note?: string,
  ): void {
    if (this.mediaPayloadDebugCount >= 20) return;
    this.mediaPayloadDebugCount += 1;

    try {
      const decodedLen = buffer ? buffer.length : null;
      const decodedPrefixHex = buffer ? buffer.subarray(0, 16).toString('hex') : null;

      log.info(
        {
          event: 'media_payload_debug',
          call_control_id: this.callControlId,
          payload_source: payloadSource ?? null,
          base64_len: base64Len,
          decoded_len: decodedLen,
          decoded_prefix_hex: decodedPrefixHex,
          note: note ?? (buffer ? undefined : 'decoded_payload_unavailable'),
          frame_seq: typeof seq === 'number' ? seq : null,
          ...(this.logContext ?? {}),
        },
        buffer ? 'MEDIA_PAYLOAD_DEBUG raw payload' : 'MEDIA_PAYLOAD_DEBUG decoded payload unavailable',
      );
    } catch (error) {
      log.warn(
        { event: 'media_payload_debug_failed', call_control_id: this.callControlId, err: error, ...(this.logContext ?? {}) },
        'MEDIA_PAYLOAD_DEBUG logging failed',
      );
    }
  }


  private async decodeAndEmit(
    buffer: Buffer,
    encoding: string,
    timestamp: number | undefined,
    seq: number | undefined,
    payloadSource?: string,
  ): Promise<void> {
    let decodeOk = false;
    let rms = 0;
    let peak = 0;

    const decodeResult = await decodeTelnyxPayloadToPcm16({
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
      const amrwbBuffering = encoding === 'AMR-WB' && this.codecState?.amrwbLastError === 'amrwb_buffering';
      // Don't mark AMR-WB frames as "tiny" just because decode failed/buffered.
      const pseudoDecodedLen = encoding === 'AMR-WB' ? 999 : 0;
      this.healthMonitor.recordPayload(buffer.length, pseudoDecodedLen, 0, 0, amrwbBuffering ? true : false);
      if (!amrwbBuffering) this.checkHealth(encoding);
      return;
    }

    // ✅ Mark "good decoded audio" as soon as we know decode succeeded
    this.lastGoodDecodedAtMs = Date.now();

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

      // seq is the canonical sequence (Telnyx seq if present, else local seq assigned upstream)
      if (typeof seq === 'number' && Number.isFinite(seq)) {
        const capture = this.captureState;

        if (capture && !capture.stopped) {
          void dumpCaptureDecodedPcm(capture, this.callControlId, seq, decodedBuf);
        }

        void dumpTelnyxDecodedPcm(this.callControlId, seq, decodedBuf);
      } else {
        // Optional: one-time log if you want visibility that dumps are being skipped
        // log.debug({ event: 'decoded_dump_skipped_no_seq', call_control_id: this.callControlId }, 'decoded dump skipped');
      }
    }


    if (pcm16.length > 0) {
      const stats = computePcmStats(pcm16);
      rms = stats.rms;
      peak = stats.peak;
    }
    decodeOk = true;

    const sampleRateHz = decodeResult.sampleRateHz;

    if (
      this.pendingPcm &&
      this.pendingPcm.length > 0 &&
      this.pendingPcmSampleRateHz &&
      this.pendingPcmSampleRateHz !== sampleRateHz
    ) {
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

      if (!this.decodedProbeLogged && diagnosticsEnabled()) {
        this.decodedProbeLogged = true;
        const pcmBuffer = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
        const meta: AudioMeta = {
          callId: this.callControlId,
          format: 'pcm16le',
          codec: encoding,
          sampleRateHz: decodeResult.sampleRateHz,
          channels: 1,
          bitDepth: 16,
          logContext: { call_control_id: this.callControlId, ...(this.logContext ?? {}) },
          lineage: ['rx.decoded.pcm16'],
        };
        attachAudioMeta(pcmBuffer, meta);
        probePcm('rx.decoded.pcm16', pcmBuffer, meta);
      }

      if (encoding === 'AMR-WB' && amrwbEmitDebugEnabled()) {
        const now = Date.now();
        if (this.shouldLogAmrwbEmitDebug(now)) {
          const counts = this.countNearZeroSamples(slice, AMRWB_NEAR_ZERO_THRESHOLD);
          const zeroRatio = slice.length > 0 ? counts.zero / slice.length : 1;
          const nearZeroRatio = slice.length > 0 ? counts.nearZero / slice.length : 1;
          log.info(
            {
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
            },
            'AMR-WB emit debug',
          );
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
      log.info(
        {
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
        },
        'media ingest decode stats',
      );
    }
  }

  private checkHealth(codec: string): void {
    const now = Date.now();
    const reason = this.healthMonitor.evaluate(now);
    if (!reason || this.ingestUnhealthyLogged) return;

    const stats = this.healthMonitor.getStats();
    this.ingestUnhealthyLogged = true;

    try {
      this.audioTap?.flush('IN_DECODED_PCM', `unhealthy_${reason}_decoded`);
      this.audioTap?.flush('EMITTED_BUFFERED', `unhealthy_${reason}_emitted`);
    } catch {
      // never allow debug to affect call flow
    }

    log.warn(
      {
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
      },
      'media ingest unhealthy',
    );

    void this.handleUnhealthy(reason, codec);
  }

  private async handleUnhealthy(reason: MediaIngestUnhealthyReason, codec: string): Promise<void> {
    // AMR-WB payloads are naturally small; never restart stream for "tiny_payloads".
    if (codec === 'AMR-WB' && reason === 'tiny_payloads') {
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }
    if (reason === 'low_rms') {
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }
    if (this.transportMode !== 'pstn') {
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }
    if (this.restartAttempts >= this.maxRestartAttempts) {
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }
    if (!this.onRestartStreaming) {
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }

    // Determine what codec we would actually request on restart
    const requestedCodec =
      this.transportMode === 'pstn' &&
      this.allowAmrWb &&
      this.acceptCodecs.has('AMR-WB')
        ? 'AMR-WB'
        : codec;

    // 🚫 STOP NO-OP RESTARTS (this is the bug)
    // If the restart would not change codecs, do NOT restart.
    // This was causing stream flapping + echo.
    if (requestedCodec === codec) {
      log.warn(
        {
          event: 'media_ingest_restart_suppressed',
          call_control_id: this.callControlId,
          reason,
          previous_codec: codec,
          requested_codec: requestedCodec,
          note: 'suppressed restart because requested_codec === previous_codec',
          ...(this.logContext ?? {}),
        },
        'media ingest restart suppressed (noop)',
      );

      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      return;
    }

    // ✅ REAL restart begins here
    this.restartAttempts += 1;
    this.healthMonitor.disable();

    log.warn(
      {
        event: 'media_ingest_restart_streaming',
        call_control_id: this.callControlId,
        attempt: this.restartAttempts,
        reason,
        previous_codec: codec,
        requested_codec: requestedCodec,
        ...(this.logContext ?? {}),
      },
      'media ingest restart streaming',
    );

    try {
      this.activeStreamId = null;
      this.lastSeqByStream.clear();

      const ok = await this.onRestartStreaming(requestedCodec, reason);

      if (ok && requestedCodec === 'AMR-WB') {
        this.pinnedCodec = 'AMR-WB';
        this.maybeEnableForceBe('AMR-WB', 'payload');
      }

      if (!ok) {
        log.warn(
          {
            event: 'media_ingest_restart_failed',
            call_control_id: this.callControlId,
            reason,
            ...(this.logContext ?? {}),
          },
          'media ingest restart failed',
        );
        if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

      }
    } catch (error) {
      log.warn(
        {
          event: 'media_ingest_restart_failed',
          call_control_id: this.callControlId,
          reason,
          err: error,
          ...(this.logContext ?? {}),
        },
        'media ingest restart failed',
      );
      if (this.shouldFireReprompt(reason)) {
  this.lastRepromptAtMs = Date.now();
  this.onReprompt?.(reason);
}

    }
  }
}
