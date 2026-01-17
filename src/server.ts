import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { env } from './env';
import { SessionManager } from './calls/sessionManager';
import { log } from './log';
import { describeWavHeader, parseWavInfo } from './audio/wavInfo';
import { runPlaybackPipeline } from './audio/playbackPipeline';
import { parseTelnyxAcceptCodecs } from './audio/codecDecode';
import { MediaIngest } from './media/mediaIngest';
import { attachAudioMeta, getAudioMeta, probeWav } from './diagnostics/audioProbe';
import { healthRouter } from './routes/health';
import { createTelnyxWebhookRouter } from './routes/telnyxWebhook';
import { createWebRtcRouter } from './routes/webrtc';
import { synthesizeSpeech } from './tts/kokoroTTS';
import { metricsHandler, metricsMiddleware, startStageTimer } from './metrics';
import { TelnyxClient } from './telnyx/telnyxClient';

type RequestWithRawBody = Request & { rawBody?: Buffer; id?: string };

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  const requestId = incomingId && incomingId.trim() !== '' ? incomingId : randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as RequestWithRawBody).id = requestId;
  next();
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_server_error' });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown_error';
}

function normalizeCodec(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!normalized) return 'PCMU';
  if (normalized === 'AMRWB' || normalized === 'AMR_WB') return 'AMR-WB';
  return normalized;
}

function normalizeTelnyxTrack(track?: string | null): string {
  const normalized = typeof track === 'string' ? track.trim().toLowerCase() : '';
  if (normalized === 'inbound_track') return 'inbound';
  if (normalized === 'outbound_track') return 'outbound';
  return normalized;
}

function mapCodecToFormat(codec: string): 'pcmu' | 'alaw' | 'pcm16le' | 'opus' | 'amrwb' | undefined {
  switch (codec) {
    case 'PCMU':
      return 'pcmu';
    case 'PCMA':
      return 'alaw';
    case 'L16':
      return 'pcm16le';
    case 'OPUS':
      return 'opus';
    case 'AMR-WB':
      return 'amrwb';
    default:
      return undefined;
  }
}

function mapCodecToBitDepth(codec: string): number | undefined {
  switch (codec) {
    case 'PCMU':
    case 'PCMA':
      return 8;
    case 'L16':
      return 16;
    default:
      return undefined;
  }
}

function shouldProbeRaw(codec: string): boolean {
  return codec === 'PCMU' || codec === 'PCMA';
}

function buildProbeMeta(
  callControlId: string,
  connection: {
    mediaEncoding?: string;
    mediaSampleRate?: number;
    mediaChannels?: number;
  },
): {
  callId: string;
  format?: 'pcmu' | 'alaw' | 'pcm16le' | 'opus' | 'amrwb';
  codec: string;
  sampleRateHz?: number;
  channels: number;
  bitDepth?: number;
  logContext: { call_control_id: string };
  lineage: string[];
} {
  const codec = normalizeCodec(connection.mediaEncoding);
  const format = mapCodecToFormat(codec);
  const bitDepth = mapCodecToBitDepth(codec);
  const sampleRateHz =
    connection.mediaSampleRate ??
    (codec === 'PCMU' || codec === 'PCMA' ? 8000 : codec === 'AMR-WB' ? 16000 : undefined);
  const channels = connection.mediaChannels ?? 1;

  return {
    callId: callControlId,
    format,
    codec,
    sampleRateHz,
    channels,
    bitDepth,
    logContext: { call_control_id: callControlId },
    lineage: ['rx.telnyx.raw'],
  };
}

function resolveAudioFilePath(requestPath: string): { id: string; filePath: string } | null {
  const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  let decoded: string;
  try {
    decoded = decodeURIComponent(safePath);
  } catch {
    return null;
  }

  const id = path.basename(decoded);
  if (!id || id === '/' || id === '.' || id === '..') {
    return null;
  }

  const baseDir = path.resolve(env.AUDIO_STORAGE_DIR);
  const resolvedPath = path.resolve(baseDir, `.${decoded}`);
  if (!resolvedPath.startsWith(`${baseDir}${path.sep}`) && resolvedPath !== baseDir) {
    return null;
  }

  return { id, filePath: resolvedPath };
}

function wavInfoLogger(route: string): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const resolved = resolveAudioFilePath(req.path);
    if (!resolved) {
      next();
      return;
    }

    const { id, filePath } = resolved;
    void fs.promises
      .readFile(filePath)
      .then((buffer) => {
        const info = parseWavInfo(buffer);
        log.info(
          {
            event: 'wav_info',
            source: 'audio_serve',
            route,
            id,
            sample_rate_hz: info.sampleRateHz,
            channels: info.channels,
            bits_per_sample: info.bitsPerSample,
            data_bytes: info.dataBytes,
            duration_ms: info.durationMs,
            file_path: filePath,
          },
          'wav info',
        );
      })
      .catch((error) => {
        log.warn(
          {
            event: 'wav_info_parse_failed',
            reason: getErrorMessage(error),
            source: 'audio_serve',
            route,
            id,
            file_path: filePath,
          },
          'wav info parse failed',
        );
      });

    next();
  };
}

function playbackServeTimer(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    const end = startStageTimer('playback_serve_ms', undefined);
    res.on('finish', () => {
      end();
    });
    next();
  };
}

function logTtsBytesReady(id: string, audio: Buffer, contentType: string | undefined, context: Record<string, unknown>): void {
  const header = describeWavHeader(audio);
  log.info(
    {
      event: 'tts_bytes_ready',
      id,
      bytes: audio.length,
      riff: header.riff,
      wave: header.wave,
      ...context,
    },
    'tts bytes ready',
  );

  if (!header.riff || !header.wave) {
    log.warn(
      {
        event: 'tts_non_wav_warning',
        id,
        content_type: contentType,
        first16_hex: header.first16Hex,
        bytes: audio.length,
        ...context,
      },
      'tts bytes are not wav',
    );
  }

  const audioLogContext = { ...context, tts_id: id };
  const baseMeta = {
    format: 'wav' as const,
    logContext: audioLogContext,
    lineage: ['tts:output'],
    kind: id,
  };
  attachAudioMeta(audio, baseMeta);
  probeWav('tts.out.raw', audio, baseMeta);

  try {
    const info = parseWavInfo(audio);
    log.info(
      {
        event: 'wav_info',
        source: 'kokoro',
        id,
        sample_rate_hz: info.sampleRateHz,
        channels: info.channels,
        bits_per_sample: info.bitsPerSample,
        data_bytes: info.dataBytes,
        duration_ms: info.durationMs,
        ...context,
      },
      'wav info',
    );
  } catch (error) {
    log.warn(
      {
        event: 'wav_info_parse_failed',
        source: 'kokoro',
        id,
        reason: getErrorMessage(error),
        ...context,
      },
      'wav info parse failed',
    );
  }
}

const MEDIA_PATH_PREFIX = '/v1/telnyx/media/';
let unsupportedEncodingCount = 0;

const mediaDebugEnabled = (): boolean => parseBoolEnv(process.env.MEDIA_DEBUG);
const mediaSchemaDebugEnabled = (): boolean => parseBoolEnv(process.env.TELNYX_DEBUG_MEDIA_SCHEMA);
const telnyxTapRawEnabled = (): boolean => parseBoolEnv(process.env.TELNYX_DEBUG_TAP_RAW);

const telnyxCaptureOnceEnabled = (): boolean => parseBoolEnv(process.env.TELNYX_CAPTURE_ONCE);
const telnyxCaptureCallId = (): string | null => {
  const raw = process.env.TELNYX_CAPTURE_CALL_ID;
  return raw && raw.trim() !== '' ? raw.trim() : null;
};
const telnyxDebugDir = (): string =>
  process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== '' ? process.env.STT_DEBUG_DIR.trim() : '/tmp/veralux-stt-debug';

const TELNYX_CAPTURE_WINDOW_MS = 3000;
const TELNYX_CAPTURE_MAX_FRAMES = 150;
const TELNYX_CAPTURE_TINY_PAYLOAD_LIMIT = 10;
const TELNYX_CAPTURE_TINY_PAYLOAD_LEN = 50;

let captureConsumed = false;
let captureActiveCallId: string | null = null;

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

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function shouldStartCapture(callControlId: string): boolean {
  if (captureConsumed) return false;
  const target = telnyxCaptureCallId();
  if (target) return target === callControlId;
  if (!telnyxCaptureOnceEnabled()) return false;
  if (!captureActiveCallId) captureActiveCallId = callControlId;
  return captureActiveCallId === callControlId;
}

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

const SENSITIVE_KEY_REGEX = /(token|authorization|auth|signature|secret|api_key)/i;

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

function summarizeCapture(capture: TelnyxMediaCaptureState, reason: string): void {
  const expectedTrack = process.env.TELNYX_STREAM_TRACK;
  const trackCombos = Array.from(capture.trackCombos);
  const payloadSources = Array.from(capture.payloadSources);
  const likelyCauses: string[] = [];

  if (expectedTrack && trackCombos.some((combo) => !combo.includes(`media:${expectedTrack}`))) likelyCauses.push('track_mismatch');
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

function decodeTelnyxPayloadWithInfo(payload: string): { buffer: Buffer; encoding: 'base64' | 'base64url'; trimmed: string } {
  let trimmed = payload.trim();
  const useBase64Url = trimmed.includes('-') || trimmed.includes('_');
  const encoding: 'base64' | 'base64url' = useBase64Url ? 'base64url' : 'base64';

  const mod = trimmed.length % 4;
  if (mod !== 0) trimmed += '='.repeat(4 - mod);

  return { buffer: Buffer.from(trimmed, encoding), encoding, trimmed };
}

/**
 * IMPORTANT FIX:
 * Don’t “pick first” payload candidate. Score candidates and choose the one that decodes to real audio.
 * This prevents the classic “payload_len=4 decoded_len=2” loop when a placeholder field exists.
 */
function pickBestPayloadCandidate(
  candidates: Array<{ source: string; value: string }>,
  codec: string,
): { source: string; value: string } | null {
  const scored = candidates
    .map((c) => {
      const raw = c.value;
      const trimmed = raw.trim();
      const base64ish = looksLikeBase64(trimmed);

      let decodedLen = 0;
      let enc: 'base64' | 'base64url' | null = null;
      let ok = false;

      if (base64ish) {
        try {
          const decoded = decodeTelnyxPayloadWithInfo(trimmed);
          decodedLen = decoded.buffer.length;
          enc = decoded.encoding;
          // Reject “obviously not audio” (tiny buffers) for audio codecs
          ok = decodedLen >= 10;
          // For AMR-WB, even stricter: < 20 bytes is almost never a valid frame payload
          if (codec === 'AMR-WB' && decodedLen < 20) ok = false;
        } catch {
          ok = false;
        }
      }

      // Primary sort keys:
      // 1) ok (true first)
      // 2) decodedLen (bigger first)
      // 3) string length (bigger first)
      return {
        c,
        base64ish,
        ok,
        decodedLen,
        strLen: trimmed.length,
        enc,
      };
    })
    // Keep only candidates that at least look like base64
    .filter((x) => x.base64ish)
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (b.decodedLen !== a.decodedLen) return b.decodedLen - a.decodedLen;
      return b.strLen - a.strLen;
    });

  return scored[0]?.c ?? null;
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

const TELNYX_RAW_PAYLOAD_PATH = '/tmp/telnyx_payload_raw.bin';
const rawPayloadInitPromises = new Map<string, Promise<void>>();

async function initTelnyxRawPayloadCapture(callControlId: string): Promise<void> {
  if (!telnyxTapRawEnabled()) return;
  const existing = rawPayloadInitPromises.get(callControlId);
  if (existing) return existing;

  const initPromise = (async () => {
    try {
      await fs.promises.writeFile(TELNYX_RAW_PAYLOAD_PATH, Buffer.alloc(0));
      log.info(
        { event: 'telnyx_raw_capture_init', call_control_id: callControlId, path: TELNYX_RAW_PAYLOAD_PATH },
        'telnyx raw capture initialized',
      );
    } catch (error) {
      log.warn(
        { event: 'telnyx_raw_capture_init_failed', call_control_id: callControlId, err: error },
        'telnyx raw capture init failed',
      );
    }
  })();

  rawPayloadInitPromises.set(callControlId, initPromise);
  return initPromise;
}

async function captureTelnyxRawPayloadFrame(callControlId: string, payload: string): Promise<void> {
  if (!telnyxTapRawEnabled()) return;
  try {
    await initTelnyxRawPayloadCapture(callControlId);
    const decoded = decodeTelnyxPayloadWithInfo(payload);
    const buffer = decoded.buffer;
    await fs.promises.appendFile(TELNYX_RAW_PAYLOAD_PATH, buffer);
    log.info(
      {
        event: 'telnyx_raw_payload_frame',
        call_control_id: callControlId,
        decoded_len: buffer.length,
        hex_prefix: buffer.subarray(0, 20).toString('hex'),
      },
      'telnyx raw payload frame captured',
    );
  } catch (error) {
    log.warn(
      { event: 'telnyx_raw_payload_frame_failed', call_control_id: callControlId, err: error },
      'telnyx raw payload frame capture failed',
    );
  }
}

function parseMediaRequest(request: http.IncomingMessage): { callControlId: string; token: string | null } | null {
  if (!request.url) return null;

  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url, `http://${host}`);
  if (!url.pathname.startsWith(MEDIA_PATH_PREFIX)) return null;

  const callControlId = url.pathname.slice(MEDIA_PATH_PREFIX.length);
  if (!callControlId || callControlId.includes('/')) return null;

  return { callControlId, token: url.searchParams.get('token') };
}

function buildMediaStreamUrl(callControlId: string): string {
  const trimmedBase = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  let wsBase = trimmedBase;
  if (trimmedBase.startsWith('https://')) {
    wsBase = `wss://${trimmedBase.slice('https://'.length)}`;
  } else if (trimmedBase.startsWith('http://')) {
    wsBase = `ws://${trimmedBase.slice('http://'.length)}`;
  } else if (!trimmedBase.startsWith('ws://') && !trimmedBase.startsWith('wss://')) {
    wsBase = `wss://${trimmedBase}`;
  }
  return `${wsBase}/v1/telnyx/media/${callControlId}?token=${encodeURIComponent(env.MEDIA_STREAM_TOKEN)}`;
}

function attachMediaWebSocketServer(server: http.Server, sessionManager: SessionManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const debugMedia = mediaDebugEnabled();

  const acceptCodecs = parseTelnyxAcceptCodecs(env.TELNYX_ACCEPT_CODECS);
  acceptCodecs.add('PCMU');
  acceptCodecs.add('PCMA');

  server.on('upgrade', (request, socket, head) => {
    const parsed = parseMediaRequest(request);
    if (!parsed) {
      socket.destroy();
      return;
    }
    if (!parsed.token || parsed.token !== env.MEDIA_STREAM_TOKEN) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as WebSocket & { callControlId?: string }).callControlId = parsed.callControlId;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    const connection = ws as WebSocket & { callControlId?: string };

    const callControlId = connection.callControlId;
    if (!callControlId) {
      ws.close(1008, 'invalid_call_control_id');
      return;
    }

    sessionManager.registerMediaConnection(callControlId, ws);
    void initTelnyxRawPayloadCapture(callControlId);

    const transportMode = sessionManager.getTransportMode(callControlId) ?? env.TRANSPORT_MODE;
    const ingest = new MediaIngest({
      callControlId,
      transportMode,
      expectedTrack: env.TELNYX_STREAM_TRACK,
      acceptCodecs,
      targetSampleRateHz: env.TELNYX_TARGET_SAMPLE_RATE,
      allowAmrWb: env.TELNYX_AMRWB_DECODE,
      allowG722: env.TELNYX_G722_DECODE,
      allowOpus: env.TELNYX_OPUS_DECODE,
      maxRestartAttempts: env.TELNYX_STREAM_RESTART_MAX,
      logContext: { call_control_id: callControlId },
      isPlaybackActive: () => sessionManager.isPlaybackActive(callControlId),
      isListening: () => sessionManager.isListening(callControlId),
      getLastSpeechStartAtMs: () => sessionManager.getLastSpeechStartAtMs(callControlId),

      onAcceptedPayload: (tap) => {
        log.info(
          {
            event: 'media_ingest_accepted_payload',
            call_control_id: tap.callControlId,
            codec: tap.codec,
            track: tap.track ?? null,
            seq: tap.seq ?? null,
            timestamp: tap.timestamp ?? null,
            payload_source: tap.payloadSource ?? null,
            decoded_len: tap.decodedLen,
            hex_prefix: tap.hexPrefix,
          },
          'accepted payload (post-gating)',
        );
      },

      onFrame: (frame) => {
        const ok = sessionManager.pushPcm16Frame(callControlId, frame);
        if (!ok) log.warn({ event: 'media_orphan_frame', call_control_id: callControlId }, 'media orphan frame');
      },
      onRestartStreaming: async (codec, reason) => {
        if (!sessionManager.isCallActive(callControlId)) {
          log.warn(
            { event: 'media_ingest_restart_skipped_inactive', call_control_id: callControlId, reason },
            'media ingest restart skipped',
          );
          return false;
        }
        const telnyx = new TelnyxClient({ call_control_id: callControlId });
        const streamUrl = buildMediaStreamUrl(callControlId);
        await telnyx.startStreaming(callControlId, streamUrl, {
          streamCodec: codec,
          streamTrack: env.TELNYX_STREAM_TRACK,
        });
        return true;
      },
      onReprompt: (reason) => {
        sessionManager.notifyIngestFailure(callControlId, reason);
      },
    });

    if (debugMedia) {
      log.info(
        {
          event: 'media_ws_connected',
          call_control_id: callControlId,
          remote: request.socket.remoteAddress,
          url: request.url,
        },
        'media ws connected',
      );
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        ingest.handleBinary(buffer);
        return;
      }

      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : '';

      if (!text) return;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        if (debugMedia) log.warn({ event: 'media_ws_parse_failed', call_control_id: callControlId, err: error }, 'media ws parse failed');
        return;
      }

      const event = typeof message.event === 'string' ? message.event : undefined;

      ingest.handleMessage(message);
      if (event === 'stop') {
        ws.close(1000, 'media_stop');
      }
    });

    ws.on('close', () => {
      sessionManager.unregisterMediaConnection(callControlId, ws);
      ingest.close('ws_close');
    });

    ws.on('error', (error) => {
      sessionManager.unregisterMediaConnection(callControlId, ws);
      ingest.close('ws_error');
      log.error({ err: error, call_control_id: callControlId }, 'media websocket error');
    });
  });

  return wss;
}

async function ensureGreetingAsset(): Promise<void> {
  const greetingPath = path.join(env.AUDIO_STORAGE_DIR, 'greeting.wav');

  try {
    const stats = await fs.promises.stat(greetingPath);
    log.info({ path: greetingPath, created: false, bytes: stats.size }, 'greeting asset ready');
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') log.warn({ err: error, path: greetingPath }, 'greeting asset stat failed');
  }

  const voice = env.KOKORO_VOICE_ID ?? 'af_bella';
  try {
    const result = await synthesizeSpeech({
      text: 'Hi! Thanks for calling. How can I help you today?',
      voice,
      format: 'wav',
    });

    logTtsBytesReady('greeting.wav', result.audio, result.contentType, { path: greetingPath });

    const pipelineApplied = env.PLAYBACK_PROFILE === 'pstn';
    if (pipelineApplied) {
      const endPipeline = startStageTimer('tts_pipeline_ms', 'unknown');
      const pipelineResult = runPlaybackPipeline(result.audio, {
        targetSampleRateHz: env.PLAYBACK_PSTN_SAMPLE_RATE,
        enableHighpass: env.PLAYBACK_ENABLE_HIGHPASS,
        logContext: { path: greetingPath },
      });
      endPipeline();
      result.audio = pipelineResult.audio;
    }

    const pipelineMeta =
      getAudioMeta(result.audio) ?? ({
        format: 'wav' as const,
        logContext: { path: greetingPath },
        lineage: ['pipeline:unknown'],
      } as const);

    if (pipelineApplied) probeWav('tts.out.telephonyOptimized', result.audio, pipelineMeta);
    probeWav('tx.telnyx.payload', result.audio, { ...pipelineMeta, kind: 'greeting.wav' });

    try {
      const info = parseWavInfo(result.audio);
      log.info(
        {
          event: 'wav_info',
          source: 'pipeline_output',
          id: 'greeting.wav',
          sample_rate_hz: info.sampleRateHz,
          channels: info.channels,
          bits_per_sample: info.bitsPerSample,
          data_bytes: info.dataBytes,
          duration_ms: info.durationMs,
          path: greetingPath,
        },
        'wav info',
      );
    } catch (error) {
      log.warn(
        {
          event: 'wav_info_parse_failed',
          source: 'pipeline_output',
          id: 'greeting.wav',
          reason: getErrorMessage(error),
          path: greetingPath,
        },
        'wav info parse failed',
      );
    }

    await fs.promises.writeFile(greetingPath, result.audio);
    log.info({ path: greetingPath, created: true, bytes: result.audio.length }, 'greeting asset ready');
  } catch (error) {
    log.error({ err: error, path: greetingPath }, 'greeting asset creation failed');
  }
}

export function buildServer(): { app: express.Express; server: http.Server; sessionManager: SessionManager } {
  const app = express();
  const sessionManager = new SessionManager();

  // Metrics first: capture full request time including JSON parsing + downstream work.
  app.use(metricsMiddleware);
  app.get('/metrics', metricsHandler);

  fs.mkdirSync(env.AUDIO_STORAGE_DIR, { recursive: true });
  log.info({ audioDir: env.AUDIO_STORAGE_DIR }, 'audio hosting configured');
  log.info(
    {
      telnyx_stream_track: env.TELNYX_STREAM_TRACK,
      stt_min_seconds: env.STT_MIN_SECONDS,
      stt_silence_min_seconds: env.STT_SILENCE_MIN_SECONDS,
      stt_partial_interval_ms: env.STT_PARTIAL_INTERVAL_MS,
      stt_max_utterance_ms: env.STT_MAX_UTTERANCE_MS,
    },
    'runtime tuning configured',
  );

  void ensureGreetingAsset();

  app.disable('x-powered-by');
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    }),
  );
  app.use(requestIdMiddleware);

  app.use('/health', healthRouter);

  const publicDir = path.resolve(process.cwd(), 'public');
  app.use('/public', express.static(publicDir));
  app.get('/hd-call', (_req, res) => {
    res.sendFile(path.join(publicDir, 'hd-call.html'));
  });

  app.get('/health/audio', (_req, res) => {
    const dir = env.AUDIO_STORAGE_DIR;
    const exists = fs.existsSync(dir);
    let fileCount = 0;
    if (exists) {
      try {
        fileCount = fs.readdirSync(dir).length;
      } catch (error) {
        log.warn({ err: error, dir }, 'audio health check read failed');
      }
    }
    res.status(200).json({ dir, exists, fileCount });
  });

  app.use('/audio', playbackServeTimer(), wavInfoLogger('/audio'), express.static(env.AUDIO_STORAGE_DIR));

  app.use('/v1/webrtc', createWebRtcRouter(sessionManager));

  const telnyxWebhookRouter = createTelnyxWebhookRouter(sessionManager);
  const telnyxWebhookRoutes = ['/v1/telnyx/webhook', '/api/telnyx/call-control'];
  for (const route of telnyxWebhookRoutes) app.use(route, telnyxWebhookRouter);
  log.info({ routes: telnyxWebhookRoutes }, 'telnyx webhook routes configured');

  app.use(errorHandler);

  const server = http.createServer(app);
  attachMediaWebSocketServer(server, sessionManager);

  return { app, server, sessionManager };
}
