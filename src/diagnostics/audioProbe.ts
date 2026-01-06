/**
 * Audio diagnostics helpers (opt-in).
 * Enable with: AUDIO_DIAGNOSTICS=1
 *
 * Common tags:
 * - rx.telnyx.raw
 * - rx.decoded.pcm
 * - stt.submit.wav | stt.submit.pcm
 * - tts.out.raw
 * - tts.out.telephonyOptimized
 * - tx.telnyx.payload
 *
 * Lineage warnings trigger if duplicate transforms are detected.
 */
import { createHash } from 'crypto';
import { env } from '../env';
import { log } from '../log';

const MAX_FINGERPRINT_BYTES = 64 * 1024;
const MAX_ANALYZE_MS = 250;
const DEFAULT_SAMPLE_RATE = 8000;

export type AudioFormat = 'pcmu' | 'alaw' | 'pcm16le' | 'f32' | 'wav' | 'opus' | 'amrwb';

export interface AudioMeta {
  callId?: string;
  sessionId?: string;
  tenantId?: string;
  format?: AudioFormat;
  container?: string;
  codec?: string;
  sampleRateHz?: number;
  channels?: number;
  bitDepth?: number;
  ptimeMs?: number;
  lineage?: string[];
  logContext?: Record<string, unknown>;
  tagHint?: string;
  kind?: string;
}

export type AudioSpanEvent =
  | 'rx'
  | 'stt_submit'
  | 'stt_result'
  | 'llm_result'
  | 'tts_start'
  | 'tts_ready'
  | 'tx_sent';

interface SpanState {
  rx?: number;
  stt_submit?: number;
  stt_result?: number;
  llm_result?: number;
  tts_start?: number;
  tts_ready?: number;
  tx_sent?: number;
}

const bufferMeta = new WeakMap<Buffer, AudioMeta>();
const spanState = new Map<string, SpanState>();
const lineageWarned = new Set<string>();

export function diagnosticsEnabled(): boolean {
  return env.AUDIO_DIAGNOSTICS === true;
}

export function attachAudioMeta(buffer: Buffer, meta: AudioMeta): AudioMeta {
  bufferMeta.set(buffer, meta);
  return meta;
}

export function getAudioMeta(buffer: Buffer): AudioMeta | undefined {
  return bufferMeta.get(buffer);
}

export function appendLineage(meta: AudioMeta | undefined, step: string): AudioMeta {
  const lineage = [...(meta?.lineage ?? []), step];
  const next: AudioMeta = { ...meta, lineage };
  warnOnDuplicateTransforms(next, step);
  return next;
}

export function markAudioSpan(event: AudioSpanEvent, meta: AudioMeta): void {
  if (!diagnosticsEnabled()) return;
  const key = resolveSpanKey(meta);
  if (!key) return;
  const state = spanState.get(key) ?? {};
  const now = Date.now();
  state[event] = now;
  spanState.set(key, state);

  const span = getSpanLabel(event);
  if (!span) return;
  const [start, end] = span;
  const startAt = state[start];
  const endAt = state[end];
  if (!startAt || !endAt) return;

  const durationMs = Math.max(0, endAt - startAt);
  log.info(
    {
      event: 'audio_span',
      span: `${start}->${end}`,
      duration_ms: durationMs,
      ...meta.logContext,
      call_id: meta.callId,
      session_id: meta.sessionId,
      tenant_id: meta.tenantId,
    },
    'audio span',
  );
}

export function probePcm(tag: string, pcm: Buffer, meta: AudioMeta = {}): void {
  if (!diagnosticsEnabled()) return;
  if (!pcm || pcm.length === 0) return;

  const format = meta.format ?? 'pcm16le';
  if (format === 'pcmu') {
    const stats = analyzePcmu(pcm, meta);
    emitProbe(tag, stats, meta);
    return;
  }

  if (format === 'pcm16le') {
    const stats = analyzePcm16(pcm, meta);
    emitProbe(tag, stats, meta);
    return;
  }

  emitProbe(tag, {
    sampleRateHz: meta.sampleRateHz,
    channels: meta.channels,
    bitDepth: meta.bitDepth,
    format,
    durationMs: null,
    frameCount: null,
    rms: null,
    peak: null,
    clippedPct: null,
    dcOffset: null,
    fingerprint: fingerprintBuffer(pcm),
  }, meta);
}

export function probeFloat32(tag: string, floats: Float32Array, meta: AudioMeta = {}): void {
  if (!diagnosticsEnabled()) return;
  if (!floats || floats.length === 0) return;

  const stats = analyzeFloat32(floats, meta);
  emitProbe(tag, stats, meta);
}

export function probeWav(tag: string, wavBytes: Buffer, meta: AudioMeta = {}): void {
  if (!diagnosticsEnabled()) return;
  if (!wavBytes || wavBytes.length === 0) return;

  try {
    const header = parseWavHeader(wavBytes);
    const format = meta.format ?? 'wav';
    const stats = analyzePcm16FromWav(wavBytes, header, meta);
    emitProbe(tag, { ...stats, format }, meta);
  } catch (error) {
    log.warn(
      {
        event: 'audio_probe_failed',
        tag,
        reason: getErrorMessage(error),
        ...meta.logContext,
        call_id: meta.callId,
        session_id: meta.sessionId,
        tenant_id: meta.tenantId,
      },
      'audio probe failed',
    );
  }
}

interface ProbeStats {
  sampleRateHz?: number;
  channels?: number;
  bitDepth?: number;
  format?: string;
  durationMs: number | null;
  frameCount: number | null;
  rms: number | null;
  peak: number | null;
  clippedPct: number | null;
  dcOffset: number | null;
  fingerprint: string;
}

function analyzePcm16(buffer: Buffer, meta: AudioMeta): ProbeStats {
  const channels = meta.channels ?? 1;
  const sampleRate = meta.sampleRateHz ?? DEFAULT_SAMPLE_RATE;
  const sampleCount = Math.floor(buffer.length / 2);
  const maxSamples = clampSampleCount(sampleCount, sampleRate, channels);

  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < maxSamples; i += 1) {
    const sample = buffer.readInt16LE(i * 2);
    const normalized = sample / 32768;
    const abs = Math.abs(normalized);
    sumSquares += normalized * normalized;
    sum += normalized;
    if (abs > peak) peak = abs;
    if (Math.abs(sample) >= 32760) clipped += 1;
  }

  const frames = Math.floor(maxSamples / channels);
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : null;

  return {
    sampleRateHz: sampleRate,
    channels,
    bitDepth: meta.bitDepth ?? 16,
    format: meta.format ?? 'pcm16le',
    durationMs,
    frameCount: frames,
    rms: maxSamples > 0 ? Math.sqrt(sumSquares / maxSamples) : null,
    peak,
    clippedPct: maxSamples > 0 ? (clipped / maxSamples) * 100 : null,
    dcOffset: maxSamples > 0 ? sum / maxSamples : null,
    fingerprint: fingerprintBuffer(buffer),
  };
}

function analyzePcmu(buffer: Buffer, meta: AudioMeta): ProbeStats {
  const channels = meta.channels ?? 1;
  const sampleRate = meta.sampleRateHz ?? DEFAULT_SAMPLE_RATE;
  const sampleCount = buffer.length;
  const maxSamples = clampSampleCount(sampleCount, sampleRate, channels);

  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < maxSamples; i += 1) {
    const sample = muLawToPcmSample(buffer[i] ?? 0);
    const normalized = sample / 32768;
    const abs = Math.abs(normalized);
    sumSquares += normalized * normalized;
    sum += normalized;
    if (abs > peak) peak = abs;
    if (Math.abs(sample) >= 32760) clipped += 1;
  }

  const frames = Math.floor(maxSamples / channels);
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : null;

  return {
    sampleRateHz: sampleRate,
    channels,
    bitDepth: meta.bitDepth ?? 8,
    format: meta.format ?? 'pcmu',
    durationMs,
    frameCount: frames,
    rms: maxSamples > 0 ? Math.sqrt(sumSquares / maxSamples) : null,
    peak,
    clippedPct: maxSamples > 0 ? (clipped / maxSamples) * 100 : null,
    dcOffset: maxSamples > 0 ? sum / maxSamples : null,
    fingerprint: fingerprintBuffer(buffer),
  };
}

function analyzeFloat32(floats: Float32Array, meta: AudioMeta): ProbeStats {
  const channels = meta.channels ?? 1;
  const sampleRate = meta.sampleRateHz ?? DEFAULT_SAMPLE_RATE;
  const sampleCount = floats.length;
  const maxSamples = clampSampleCount(sampleCount, sampleRate, channels);

  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < maxSamples; i += 1) {
    const sample = floats[i] ?? 0;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    sum += sample;
    if (abs > peak) peak = abs;
    if (abs >= 0.999) clipped += 1;
  }

  const frames = Math.floor(maxSamples / channels);
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : null;

  const bytes = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
  return {
    sampleRateHz: sampleRate,
    channels,
    bitDepth: meta.bitDepth ?? 32,
    format: meta.format ?? 'f32',
    durationMs,
    frameCount: frames,
    rms: maxSamples > 0 ? Math.sqrt(sumSquares / maxSamples) : null,
    peak,
    clippedPct: maxSamples > 0 ? (clipped / maxSamples) * 100 : null,
    dcOffset: maxSamples > 0 ? sum / maxSamples : null,
    fingerprint: fingerprintBuffer(bytes),
  };
}

function analyzePcm16FromWav(
  wav: Buffer,
  header: WavHeader,
  meta: AudioMeta,
): ProbeStats {
  const dataBytes = Math.min(header.dataBytes, Math.max(0, wav.length - header.dataOffset));
  const sampleCount = Math.floor(dataBytes / 2);
  const sampleRate = header.sampleRateHz;
  const channels = header.channels;
  const maxSamples = clampSampleCount(sampleCount, sampleRate, channels);

  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < maxSamples; i += 1) {
    const offset = header.dataOffset + i * 2;
    if (offset + 2 > wav.length) break;
    const sample = wav.readInt16LE(offset);
    const normalized = sample / 32768;
    const abs = Math.abs(normalized);
    sumSquares += normalized * normalized;
    sum += normalized;
    if (abs > peak) peak = abs;
    if (Math.abs(sample) >= 32760) clipped += 1;
  }

  const frames = Math.floor(maxSamples / channels);
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : null;

  return {
    sampleRateHz: sampleRate,
    channels,
    bitDepth: header.bitsPerSample,
    format: meta.format ?? 'wav',
    durationMs,
    frameCount: frames,
    rms: maxSamples > 0 ? Math.sqrt(sumSquares / maxSamples) : null,
    peak,
    clippedPct: maxSamples > 0 ? (clipped / maxSamples) * 100 : null,
    dcOffset: maxSamples > 0 ? sum / maxSamples : null,
    fingerprint: fingerprintBuffer(wav),
  };
}

interface WavHeader {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
}

function parseWavHeader(buffer: Buffer): WavHeader {
  if (buffer.length < 12) throw new Error('wav_header_too_small');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('invalid_riff_header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > buffer.length) throw new Error('fmt_chunk_truncated');
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataBytes = chunkSize;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkStart + paddedSize;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
    throw new Error('missing_fmt_chunk');
  }
  if (dataOffset === 0 || dataBytes === 0) {
    throw new Error('missing_data_chunk');
  }

  return { audioFormat, channels, sampleRateHz, bitsPerSample, dataOffset, dataBytes };
}

function emitProbe(tag: string, stats: ProbeStats, meta: AudioMeta): void {
  const lineage = meta.lineage ?? [];
  log.info(
    {
      event: 'audio_probe',
      tag,
      sample_rate_hz: stats.sampleRateHz ?? meta.sampleRateHz,
      channels: stats.channels ?? meta.channels,
      bits_per_sample: stats.bitDepth ?? meta.bitDepth,
      format: stats.format ?? meta.format,
      codec: meta.codec,
      container: meta.container,
      duration_ms: stats.durationMs,
      frame_count: stats.frameCount,
      rms: stats.rms !== null ? Number(stats.rms.toFixed(6)) : null,
      peak: stats.peak !== null ? Number(stats.peak.toFixed(6)) : null,
      clipped_pct: stats.clippedPct !== null ? Number(stats.clippedPct.toFixed(4)) : null,
      dc_offset: stats.dcOffset !== null ? Number(stats.dcOffset.toFixed(6)) : null,
      fingerprint: stats.fingerprint,
      lineage,
      kind: meta.kind,
      ...meta.logContext,
      call_id: meta.callId,
      session_id: meta.sessionId,
      tenant_id: meta.tenantId,
    },
    'audio probe',
  );
}

function clampSampleCount(sampleCount: number, sampleRate: number, channels: number): number {
  if (sampleCount <= 0) return 0;
  if (sampleRate <= 0 || channels <= 0) return Math.min(sampleCount, 4000);
  const maxFrames = Math.max(1, Math.round((sampleRate * MAX_ANALYZE_MS) / 1000));
  const maxSamples = maxFrames * channels;
  return Math.min(sampleCount, maxSamples);
}

function fingerprintBuffer(buffer: Buffer): string {
  const length = buffer.length;
  const slice = buffer.subarray(0, Math.min(length, MAX_FINGERPRINT_BYTES));
  return createHash('sha1').update(slice).update(String(length)).digest('hex');
}

function resolveSpanKey(meta: AudioMeta): string | null {
  if (meta.callId) return `call:${meta.callId}`;
  if (meta.sessionId) return `session:${meta.sessionId}`;
  const callId = meta.logContext?.call_control_id;
  if (typeof callId === 'string') return `call:${callId}`;
  return null;
}

function getSpanLabel(event: AudioSpanEvent): [AudioSpanEvent, AudioSpanEvent] | null {
  switch (event) {
    case 'stt_submit':
      return ['rx', 'stt_submit'];
    case 'stt_result':
      return ['stt_submit', 'stt_result'];
    case 'llm_result':
      return ['stt_result', 'llm_result'];
    case 'tts_start':
      return ['llm_result', 'tts_start'];
    case 'tts_ready':
      return ['tts_start', 'tts_ready'];
    case 'tx_sent':
      return ['tts_ready', 'tx_sent'];
    default:
      return null;
  }
}

function warnOnDuplicateTransforms(meta: AudioMeta, step: string): void {
  if (!diagnosticsEnabled()) return;
  const lineage = meta.lineage ?? [];
  if (lineage.length < 2) return;
  const counts = new Map<string, number>();
  for (const entry of lineage) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([entry]) => entry);
  if (duplicates.length === 0) return;

  const keyId = resolveSpanKey(meta) ?? 'unknown';
  const key = `${keyId}:${duplicates.sort().join('|')}`;
  if (lineageWarned.has(key)) return;
  lineageWarned.add(key);

  log.warn(
    {
      event: 'audio_lineage_duplicate',
      duplicate_steps: duplicates,
      lineage,
      last_step: step,
      ...meta.logContext,
      call_id: meta.callId,
      session_id: meta.sessionId,
      tenant_id: meta.tenantId,
    },
    'audio lineage duplicate detected',
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown_error';
}

function muLawToPcmSample(uLawByte: number): number {
  const u = (~uLawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const bias = 0x84;
  let sample = ((mantissa << 3) + bias) << exponent;
  sample -= bias;
  if (sign) sample = -sample;
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample | 0;
}