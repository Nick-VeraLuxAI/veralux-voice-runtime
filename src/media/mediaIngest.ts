import fs from 'fs';
import path from 'path';
import { decodeTelnyxPayloadToPcm16, type TelnyxCodecState } from '../audio/codecDecode';
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
};

const DEFAULT_HEALTH_WINDOW_MS = 1000;
const DEFAULT_HEALTH_RMS_FLOOR = 0.001;
const DEFAULT_HEALTH_MIN_FRAMES = 10;
const DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT = 10;
const DEFAULT_HEALTH_DECODE_FAILURE_LIMIT = 5;
const DEFAULT_FRAME_MS = 20;

const TELNYX_CAPTURE_WINDOW_MS = 3000;
const TELNYX_CAPTURE_MAX_FRAMES = 150;
const TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT = 10;
const TELNYX_CAPTURE_TINY_PAYLOAD_LEN = 50;

let captureConsumed = false;
let captureActiveCallId: string | null = null;

const SENSITIVE_KEY_REGEX = /(token|authorization|auth|signature|secret|api_key)/i;

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

const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;

function amrWbFrameSize(ft: number): number {
  if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length) return AMRWB_FRAME_SIZES[ft] ?? 0;
  if (ft === 9) return AMRWB_SID_FRAME_BYTES;
  return 0;
}

function debugParseAmrWbOctetAligned(payload: Buffer, startOffset: number): { frames: number; reason?: string } {
  if (payload.length === 0) return { frames: 0, reason: 'empty' };
  if (startOffset >= payload.length) return { frames: 0, reason: 'start_offset_out_of_range' };

  let offset = startOffset;
  const tocEntries: number[] = [];
  let follow = true;

  while (follow && offset < payload.length) {
    const toc = payload[offset++];
    follow = (toc & 0x80) !== 0;
    const ft = (toc >> 3) & 0x0f;
    tocEntries.push(ft);
  }

  let frames = 0;
  for (const ft of tocEntries) {
    const size = amrWbFrameSize(ft);
    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) return { frames, reason: `sid_overflow_ft_${ft}` };
      offset += size;
      continue;
    }
    if (size <= 0) return { frames, reason: `invalid_ft_${ft}` };
    if (offset + size > payload.length) return { frames, reason: `frame_overflow_ft_${ft}` };
    frames += 1;
    offset += size;
  }

  return { frames, reason: frames === 0 ? 'no_frames' : undefined };
}

function debugParseAmrWbPayload(payload: Buffer): { ok: boolean; mode: string; frames: number; reason?: string } {
  if (payload.length === 0) return { ok: false, mode: 'empty', frames: 0, reason: 'empty' };
  if (AMRWB_FRAME_SIZES.includes(payload.length)) return { ok: true, mode: 'single', frames: 1 };
  if (payload.length === AMRWB_SID_FRAME_BYTES) return { ok: true, mode: 'sid', frames: 0 };
  if (payload.length < 2) return { ok: false, mode: 'too_short', frames: 0, reason: 'payload_too_short' };

  const withCmr = debugParseAmrWbOctetAligned(payload, 1);
  if (!withCmr.reason && withCmr.frames >= 0) return { ok: true, mode: 'octet_cmr', frames: withCmr.frames };

  const withoutCmr = debugParseAmrWbOctetAligned(payload, 0);
  if (!withoutCmr.reason && withoutCmr.frames >= 0) return { ok: true, mode: 'octet_no_cmr', frames: withoutCmr.frames };

  return {
    ok: false,
    mode: 'octet_failed',
    frames: 0,
    reason: `${withCmr.reason ?? 'unknown'}|${withoutCmr.reason ?? 'unknown'}`,
  };
}

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
          ok = decodedLen >= 10;
          if (codec === 'AMR-WB' && decodedLen < 20) ok = false;
        } catch {
          ok = false;
        }
      }

      return {
        c,
        base64ish,
        ok,
        decodedLen,
        strLen: trimmed.length,
      };
    })
    .filter((x) => x.base64ish)
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (b.decodedLen !== a.decodedLen) return b.decodedLen - a.decodedLen;
      return b.strLen - a.strLen;
    });

  return scored[0]?.c ?? null;
}

function normalizeCodec(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!normalized) return 'PCMU';
  if (normalized === 'AMRWB' || normalized === 'AMR_WB') return 'AMR-WB';
  return normalized;
}

export function normalizeTelnyxTrack(track?: string | null): string {
  const normalized = typeof track === 'string' ? track.trim().toLowerCase() : '';
  if (normalized === 'inbound_track') return 'inbound';
  if (normalized === 'outbound_track') return 'outbound';
  return normalized;
}

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
    log.warn({ event: 'media_capture_write_failed', call_control_id: capture.callControlId, err: error }, 'media capture write failed');
  }
}

async function dumpCaptureFrame(capture: TelnyxMediaCaptureState, callControlId: string, seq: number, buffer: Buffer): Promise<void> {
  const base = path.join(capture.dir, `capture_${callControlId}_${seq}_${Date.now()}`);
  try {
    await fs.promises.writeFile(`${base}.bin`, buffer);
  } catch (error) {
    log.warn({ event: 'media_capture_dump_failed', call_control_id: callControlId, err: error }, 'media capture dump failed');
  }
}

async function dumpTelnyxRawPayload(callControlId: string, payload: string, buffer: Buffer): Promise<void> {
  if (!telnyxTapRawEnabled()) return;
  const dir = telnyxDebugDir();
  const base = path.join(dir, `telnyx_raw_${callControlId}_${Date.now()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(`${base}.bin`, buffer);
    await fs.promises.writeFile(`${base}.txt`, payload);
  } catch (error) {
    log.warn({ event: 'telnyx_raw_dump_failed', call_control_id: callControlId, err: error }, 'telnyx raw dump failed');
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

export class MediaIngestHealthMonitor {
  private startedAtMs?: number;
  private endAtMs?: number;
  private totalFrames = 0;
  private decodedFrames = 0;
  private silentFrames = 0;
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
    this.totalFrames += 1;
    if (!decodeOk) {
      this.decodeFailures += 1;
    } else {
      this.decodedFrames += 1;
      if (rms < DEFAULT_HEALTH_RMS_FLOOR) this.silentFrames += 1;
    }
    if (decodedLen < DEFAULT_HEALTH_TINY_PAYLOAD_LIMIT) this.tinyPayloadFrames += 1;
    this.lastRms = rms;
    this.lastPeak = peak;
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
    if (this.decodedFrames > 0 && this.silentFrames / this.decodedFrames >= 0.8) return 'low_rms';

    return null;
  }

  public getStats(): {
    totalFrames: number;
    decodedFrames: number;
    silentFrames: number;
    tinyPayloadFrames: number;
    decodeFailures: number;
    lastRms: number;
    lastPeak: number;
  } {
    return {
      totalFrames: this.totalFrames,
      decodedFrames: this.decodedFrames,
      silentFrames: this.silentFrames,
      tinyPayloadFrames: this.tinyPayloadFrames,
      decodeFailures: this.decodeFailures,
      lastRms: this.lastRms,
      lastPeak: this.lastPeak,
    };
  }
}

export class MediaIngest {
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

  private readonly healthMonitor = new MediaIngestHealthMonitor();

  private mediaEncoding?: string;
  private mediaSampleRate?: number;
  private mediaChannels?: number;
  private mediaCodecLogged = false;
  private mediaSchemaLogged = false;
  private payloadSourceLogged = false;
  private frameSeq = 0;
  private decodedProbeLogged = false;
  private rawProbeLogged = false;
  private captureState?: TelnyxMediaCaptureState;
  private codecState: TelnyxCodecState = {};
  private pendingPcm?: Int16Array;
  private lastStatsLogAt = 0;
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
    const maxRestartAttempts =
      typeof options.maxRestartAttempts === 'number' && Number.isFinite(options.maxRestartAttempts)
        ? options.maxRestartAttempts
        : 1;
    this.maxRestartAttempts = Math.max(0, maxRestartAttempts);

    this.captureState = initCaptureState(this.callControlId) ?? undefined;
    if (this.captureState) {
      log.info(
        { event: 'media_capture_started', call_control_id: this.callControlId, ndjson: this.captureState.ndjsonPath },
        'media capture started',
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
      },
      'media ingest start',
    );
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

    if (event === 'connected') {
      return;
    }

    if (event === 'start') {
      this.handleStartEvent(message);
      return;
    }

    if (event === 'stop') {
      if (this.captureState && !this.captureState.stopped) finalizeCapture(this.captureState, 'ws_stop');
      return;
    }

    if (event !== 'media') return;

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
        },
        'media payload source selected',
      );
    }

    this.frameSeq += 1;

    let buffer: Buffer;
    let encodingUsed: Base64Encoding = 'base64';
    let trimmedPayload = payload.trim();
    const payloadLooksBase64 = looksLikeBase64(trimmedPayload);

    try {
      const decoded = decodeTelnyxPayloadWithInfo(trimmedPayload);
      buffer = decoded.buffer;
      encodingUsed = decoded.encoding;
      trimmedPayload = decoded.trimmed;
    } catch (error) {
      log.warn({ event: 'media_ws_decode_failed', call_control_id: this.callControlId, err: error }, 'media ws decode failed');
      return;
    }

    void dumpTelnyxRawPayload(this.callControlId, trimmedPayload, buffer);

    if (capture && !capture.stopped) {
      const payloadLen = trimmedPayload.length;
      capture.frameCount += 1;
      if (payloadLen < TELNYX_CAPTURE_TINY_PAYLOAD_LEN) capture.tinyPayloadFrames += 1;
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
      const seq = this.frameSeq;
      const timestamp = typeof media?.timestamp === 'number' ? media.timestamp : undefined;

      const notAudio = currentCodec === 'AMR-WB' ? buffer.length < 20 : buffer.length < 10;
      if (notAudio) capture.notAudioFrames += 1;

      const amrwbParse = currentCodec === 'AMR-WB' ? debugParseAmrWbPayload(buffer) : null;
      if (!amrwbParse?.ok && amrwbParse) {
        log.warn(
          {
            event: 'amrwb_capture_parse_failed',
            call_control_id: this.callControlId,
            reason: amrwbParse.reason ?? 'unknown',
            payload_len: buffer.length,
            payload_prefix_hex: decodedPrefixHex,
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
        seq,
        timestamp,
        payload_base64: payloadLooksBase64,
        not_audio: notAudio,
        amrwb_parse: amrwbParse,
      });

      void dumpCaptureFrame(capture, this.callControlId, seq, buffer);

      if (capture.startedAtMs && (Date.now() > (capture.endAtMs ?? 0) || capture.frameCount >= TELNYX_CAPTURE_MAX_FRAMES)) {
        finalizeCapture(capture, 'capture_window_elapsed');
      } else if (capture.tinyPayloadFrames >= TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT) {
        finalizeCapture(capture, 'tiny_payloads_exceeded');
      }
    }

    if (buffer.length < 10) {
      log.info(
        {
          event: 'media_payload_suspicious',
          call_control_id: this.callControlId,
          codec: currentCodec,
          payload_len: trimmedPayload.length,
          decoded_len: buffer.length,
          payload_source: payloadSource,
          frame_seq: this.frameSeq,
          track: resolvedTrack ?? null,
        },
        'media payload too short',
      );
      this.healthMonitor.recordPayload(trimmedPayload.length, buffer.length, 0, 0, false);
      this.checkHealth(currentCodec);
      return;
    }

    if (this.expectedTrack && this.expectedTrack !== 'both_tracks' && normalizedTrack && this.expectedTrack !== normalizedTrack) {
      if (normalizedTrack === 'outbound') this.rxFramesOutboundSkipped += 1;
      else this.rxFramesUnknownTrackSkipped += 1;
      log.info(
        {
          event: 'media_track_skipped',
          call_control_id: this.callControlId,
          expected_track: this.expectedTrack,
          got_track: normalizedTrack,
          frame_seq: this.frameSeq,
          bytes: buffer.length,
        },
        'media track skipped',
      );
      return;
    }

    if (normalizedTrack === 'inbound') this.rxFramesInbound += 1;

    this.handleEncodedPayload(buffer, media?.timestamp as number | undefined, this.frameSeq, payloadSource);
  }

  public close(reason: string): void {
    if (this.captureState && !this.captureState.stopped) finalizeCapture(this.captureState, reason);
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }

  private getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private handleStartEvent(message: Record<string, unknown>): void {
    const start = message.start && typeof message.start === 'object' ? (message.start as Record<string, unknown>) : {};
    const mediaFormat =
      (start.media_format as Record<string, unknown> | undefined) ??
      (message.media_format as Record<string, unknown> | undefined) ??
      undefined;

    const encoding = mediaFormat ? this.getString(mediaFormat.encoding) : undefined;
    const sampleRate = mediaFormat ? this.getNumber((mediaFormat as any).sample_rate ?? (mediaFormat as any).sampleRate) : undefined;
    const channels = mediaFormat ? this.getNumber(mediaFormat.channels) : undefined;

    const normalizedEncoding = normalizeCodec(encoding ?? this.mediaEncoding);
    if (encoding) {
      this.mediaEncoding = normalizedEncoding;
      this.mediaSampleRate = sampleRate ?? (normalizedEncoding === 'AMR-WB' ? 16000 : undefined);
      this.mediaChannels = channels;
    }

    if (!this.mediaCodecLogged) {
      this.mediaCodecLogged = true;
      log.info(
        {
          event: 'media_ingest_codec_detected',
          call_control_id: this.callControlId,
          codec: normalizedEncoding,
          sample_rate: sampleRate ?? (normalizedEncoding === 'AMR-WB' ? 16000 : undefined),
          channels,
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

  private handleEncodedPayload(buffer: Buffer, timestamp?: number, seq?: number, payloadSource?: string): void {
    const encoding = normalizeCodec(this.mediaEncoding);
    const support = this.isCodecSupported(encoding);
    if (!support.supported) {
      log.warn(
        { event: 'media_ingest_codec_unsupported', call_control_id: this.callControlId, encoding, reason: support.reason },
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
        logContext: { call_control_id: this.callControlId },
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
            },
            'audio probe skipped for non-PCM codec',
          );
        }
      }
      markAudioSpan('rx', meta);
    }

    void this.decodeAndEmit(buffer, encoding, timestamp, seq, payloadSource);
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
      logContext: { call_control_id: this.callControlId },
    });

    if (!decodeResult) {
      this.healthMonitor.recordPayload(buffer.length, 0, 0, 0, false);
      this.checkHealth(encoding);
      return;
    }

    const pcm16 = decodeResult.pcm16;
    if (pcm16.length > 0) {
      const stats = computePcmStats(pcm16);
      rms = stats.rms;
      peak = stats.peak;
    }
    decodeOk = true;

    const frameSamples = Math.max(1, Math.round((this.targetSampleRateHz * DEFAULT_FRAME_MS) / 1000));
    let combined = pcm16;
    if (this.pendingPcm && this.pendingPcm.length > 0) {
      const merged = new Int16Array(this.pendingPcm.length + pcm16.length);
      merged.set(this.pendingPcm);
      merged.set(pcm16, this.pendingPcm.length);
      combined = merged;
      this.pendingPcm = undefined;
    }

    let offset = 0;
    let framesEmitted = 0;

    while (combined.length - offset >= frameSamples) {
      const slice = combined.subarray(offset, offset + frameSamples);
      offset += frameSamples;
      framesEmitted += 1;

      if (!this.decodedProbeLogged && diagnosticsEnabled()) {
        this.decodedProbeLogged = true;
        const pcmBuffer = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
        const meta = {
          callId: this.callControlId,
          format: 'pcm16le' as const,
          codec: encoding,
          sampleRateHz: decodeResult.sampleRateHz,
          channels: 1,
          bitDepth: 16,
          logContext: { call_control_id: this.callControlId },
          lineage: ['rx.decoded.pcm16'],
        };
        attachAudioMeta(pcmBuffer, meta);
        probePcm('rx.decoded.pcm16', pcmBuffer, meta);
      }

      this.onFrame({
        callControlId: this.callControlId,
        pcm16: slice,
        sampleRateHz: decodeResult.sampleRateHz,
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
    }

    this.healthMonitor.recordPayload(buffer.length, buffer.length, rms, peak, decodeOk);
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
          tiny_payload_frames: stats.tinyPayloadFrames,
          decode_failures: stats.decodeFailures,
          rx_frames_inbound: this.rxFramesInbound,
          rx_frames_outbound_skipped: this.rxFramesOutboundSkipped,
          rx_frames_unknown_track_skipped: this.rxFramesUnknownTrackSkipped,
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

    log.warn(
      {
        event: 'media_ingest_unhealthy',
        call_control_id: this.callControlId,
        reason,
        codec,
        total_frames: stats.totalFrames,
        decoded_frames: stats.decodedFrames,
        silent_frames: stats.silentFrames,
        tiny_payload_frames: stats.tinyPayloadFrames,
        decode_failures: stats.decodeFailures,
        last_rms: Number(stats.lastRms.toFixed(6)),
        last_peak: Number(stats.lastPeak.toFixed(6)),
      },
      'media ingest unhealthy',
    );

    void this.handleUnhealthy(reason, codec);
  }

  private async handleUnhealthy(reason: MediaIngestUnhealthyReason, codec: string): Promise<void> {
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

    log.warn(
      {
        event: 'media_ingest_restart_streaming',
        call_control_id: this.callControlId,
        attempt: this.restartAttempts,
        reason,
        requested_codec: 'PCMU',
      },
      'media ingest restart streaming',
    );

    try {
      const ok = await this.onRestartStreaming('PCMU', reason);
      if (!ok) {
        log.warn(
          { event: 'media_ingest_restart_failed', call_control_id: this.callControlId, reason },
          'media ingest restart failed',
        );
        this.onReprompt?.(reason);
      }
    } catch (error) {
      log.warn(
        { event: 'media_ingest_restart_failed', call_control_id: this.callControlId, reason, err: error },
        'media ingest restart failed',
      );
      this.onReprompt?.(reason);
    }
  }
}
