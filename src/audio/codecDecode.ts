// src/audio/codecDecode.ts
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { log } from '../log';
import { G722Decoder } from './vendor/g722/g722';
import { encodePcm16ToWav } from './postprocess';
import { OpusPacketDecoder } from './opusDecoder';
import { resample48kTo16k } from './resample48kTo16k';
import { transcodeTelnyxAmrWbPayload, writeAmrwbArtifacts } from './amrwbRtp';

export interface TelnyxCodecState {
  // AMR-WB (ffmpeg) state + log gating
  amrwbFfmpegChecked?: boolean;
  amrwbFfmpegUsable?: boolean;
  amrwbLastError?: string;
  amrwbDepacketizeLogged?: boolean;
  amrwbDepacketizeFailedLogged?: boolean;
  amrwbDepackInvalidCount?: number;
  amrwbFfmpegOkLogged?: boolean;
  amrwbFfmpegFailedLogged?: boolean;
  amrwbFfmpegStream?: AmrWbFfmpegStream;
  amrwbFfmpegStreamRate?: number;
  amrwbFfmpegStreamDisabled?: boolean;
  amrwbFfmpegStreamOkLogged?: boolean;
  amrwbFfmpegStreamFailedLogged?: boolean;
  amrwbDebugCount?: number;
  amrwbDebugDropoutCount?: number;
  amrwbDebugLastLogAt?: number;
  amrwbShortPcmCount?: number;
  amrwbCandidateSelectedLogged?: boolean;
  amrwbPathSelectedLogged?: boolean;
  amrwbFallbackLogged?: boolean;

  // AMR-WB buffering (stitch frames across packets; decode in batches)
  amrwbFrameBuf?: Buffer[]; // storage frames (TOC+speech), NO header
  amrwbFrameBufDecodedFrames?: number; // count of speech frames in buffer
  amrwbFrameBufLastFlushMs?: number; // NOTE: used as "buffer start ms" (not last flush)

  // AMR-WB selected storage debug artifact (append-only; no trimming to avoid mid-frame corruption)
  amrwbSelectedStorageLastDumpMs?: number;
  amrwbSelectedStorageWrite?: Promise<void>;

  // G.722
  g722?: G722Decoder;

  // Opus
  opus?: OpusPacketDecoder;
  opusFailed?: boolean;
  opusChannels?: number;

  // Debug + log gating
  ingestLogged?: boolean;
  opusLogged?: boolean;

  debugLastPostDecodeMs?: number;
  debugLastPcmDumpMs?: number;
  debugPcmAccum?: Int16Array[];
  debugPcmAccumSamples?: number;
  debugPcmAccumSampleRateHz?: number;
  debugPcmDumpIndex?: number;
  debugRollingPcm16?: Int16Array;
  debugLastChunkDumpMs?: number;
  debugChunkDumpIndex?: number;
}

export interface DecodeTelnyxOptions {
  encoding: string;
  payload: Buffer;
  forceAmrWbBe?: boolean;
  channels?: number;
  reportedSampleRateHz?: number;
  targetSampleRateHz: number;
  allowAmrWb: boolean;
  allowG722: boolean;
  allowOpus: boolean;
  state?: TelnyxCodecState;
  logContext?: Record<string, unknown>;
}

export interface DecodeTelnyxResult {
  pcm16: Int16Array;
  sampleRateHz: number;
  decodedFrames?: number;
  decodeFailures?: number;
}

const SESSION_STATE_CACHE = new Map<string, TelnyxCodecState>();

function getSessionKey(logContext?: Record<string, unknown>): string | null {
  const id =
    (typeof logContext?.call_control_id === 'string' && (logContext.call_control_id as string)) ||
    (typeof logContext?.sessionId === 'string' && (logContext.sessionId as string)) ||
    (typeof logContext?.callId === 'string' && (logContext.callId as string)) ||
    null;

  return id ? String(id) : null;
}

function getOrCreateSessionState(
  provided: TelnyxCodecState | undefined,
  logContext?: Record<string, unknown>,
): TelnyxCodecState {
  if (provided) return provided;

  const key = getSessionKey(logContext);
  if (!key) return {};

  const existing = SESSION_STATE_CACHE.get(key);
  if (existing) return existing;

  const created: TelnyxCodecState = {};
  SESSION_STATE_CACHE.set(key, created);

  // keep cache bounded
  const max = Number.parseInt(process.env.CODEC_STATE_CACHE_MAX ?? '128', 10);
  const maxSessions = Number.isFinite(max) && max > 0 ? max : 128;
  if (SESSION_STATE_CACHE.size > maxSessions) {
    const firstKey = SESSION_STATE_CACHE.keys().next().value as string | undefined;
    if (firstKey) SESSION_STATE_CACHE.delete(firstKey);
  }

  return created;
}

/**
 * Accept-Codecs header normalization used upstream.
 */
export function parseTelnyxAcceptCodecs(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;

  for (const part of raw.split(',')) {
    const normalized = part.trim().toUpperCase();
    if (!normalized) continue;
    set.add(normalized === 'AMRWB' || normalized === 'AMR_WB' ? 'AMR-WB' : normalized);
  }
  return set;
}

/**
 * Should we ingest PCM16 from Telnyx (vs PCMU-only)?
 */
export function shouldUsePcm16Ingest(
  acceptCodecs: Set<string>,
  allowAmrWb: boolean,
  allowG722: boolean,
  allowOpus: boolean,
): boolean {
  for (const codec of acceptCodecs) {
    if (codec !== 'PCMU') return true;
  }
  return allowAmrWb || allowG722 || allowOpus;
}

const DEFAULT_OPUS_SAMPLE_RATE = 48000;
const DEBUG_POST_DECODE_INTERVAL_MS = 1000;
const DEBUG_CHUNK_MIN_MS = 50;
const DEBUG_CHUNK_MAX_MS = 120; // keep small; enough to hear shape, not huge spam
const DEBUG_CHUNK_INTERVAL_MS = 300; // rate-limit chunk dumping
const DEBUG_WINDOW_MS = 400;

const AMRWB_STREAM_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');
const AMRWB_FRAME_RATE = 50;
const AMRWB_STREAM_STDERR_MAX_BYTES = 4096;
const AMRWB_DEBUG_MAX_FRAMES = 30;
const AMRWB_DEBUG_MAX_DROPOUTS = 50;
const AMRWB_DEBUG_INTERVAL_MS = 1000;
const AMRWB_MIN_DECODE_FRAMES = Number.parseInt(process.env.AMRWB_MIN_DECODE_FRAMES ?? '10', 10); // ~200ms
const AMRWB_MAX_BUFFER_MS = Number.parseInt(process.env.AMRWB_MAX_BUFFER_MS ?? '500', 10); // safety flush

/* ---------------------------------- utils --------------------------------- */

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function debugPostDecodeEnabled(): boolean {
  return (
    parseBoolEnv(process.env.TELNYX_DEBUG_TAP_POST_DECODE) || parseBoolEnv(process.env.STT_DEBUG_DUMP_POST_DECODE)
  );
}

function debugPcmDumpEnabled(): boolean {
  return parseBoolEnv(process.env.STT_DEBUG_DUMP_PCM16);
}

function amrwbDecodeDebugEnabled(): boolean {
  return parseBoolEnv(process.env.AMRWB_DECODE_DEBUG);
}

function amrwbStrictDecodeEnabled(): boolean {
  return parseBoolEnv(process.env.AMRWB_STRICT_DECODE);
}

function debugDir(): string {
  return process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== ''
    ? process.env.STT_DEBUG_DIR.trim()
    : '/tmp/veralux-stt-debug';
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

function countZeroSamples(samples: Int16Array): number {
  let count = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i] === 0) count += 1;
  }
  return count;
}

function shouldLogAmrwbDebug(state: TelnyxCodecState, now: number, isDropout: boolean): boolean {
  if (!amrwbDecodeDebugEnabled()) return false;
  const lastLogAt = state.amrwbDebugLastLogAt ?? 0;
  const count = state.amrwbDebugCount ?? 0;
  const dropoutCount = state.amrwbDebugDropoutCount ?? 0;

  if (isDropout && dropoutCount < AMRWB_DEBUG_MAX_DROPOUTS) {
    state.amrwbDebugDropoutCount = dropoutCount + 1;
    state.amrwbDebugLastLogAt = now;
    return true;
  }

  if (count < AMRWB_DEBUG_MAX_FRAMES || now - lastLogAt >= AMRWB_DEBUG_INTERVAL_MS) {
    state.amrwbDebugCount = count + 1;
    state.amrwbDebugLastLogAt = now;
    return true;
  }

  return false;
}

function takeRollingWindowPcm16(
  state: TelnyxCodecState,
  pcm16: Int16Array,
  sampleRateHz: number,
  windowMs: number,
): Int16Array | null {
  const winSamples = Math.max(1, Math.round((sampleRateHz * windowMs) / 1000));
  const prev = state.debugRollingPcm16 ?? new Int16Array(0);

  const merged = new Int16Array(prev.length + pcm16.length);
  merged.set(prev, 0);
  merged.set(pcm16, prev.length);

  const start = Math.max(0, merged.length - winSamples);
  const sliced = merged.subarray(start);

  state.debugRollingPcm16 = new Int16Array(sliced);

  if (merged.length < winSamples) return null;

  return state.debugRollingPcm16;
}

async function maybeDumpPostDecode(
  samples: Int16Array,
  sampleRateHz: number,
  encoding: string,
  state: TelnyxCodecState | undefined,
  logContext: Record<string, unknown> | undefined,
): Promise<void> {
  if (!debugPostDecodeEnabled()) return;
  if (!state) return;
  if (!samples || samples.length === 0 || sampleRateHz <= 0) return;

  const callId = typeof logContext?.call_control_id === 'string' ? (logContext.call_control_id as string) : 'unknown';

  const dir = path.join(debugDir(), callId);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (error) {
    log.warn(
      { event: 'stt_post_decode_dump_failed', encoding, file_path: dir, err: error, ...(logContext ?? {}) },
      'stt post-decode dump failed',
    );
    return;
  }

  const now = Date.now();

  /* ----------------------- (A) CHUNK DUMP (>=50ms) ----------------------- */

  const chunkMinSamples = Math.max(1, Math.round((sampleRateHz * DEBUG_CHUNK_MIN_MS) / 1000));
  const chunkMaxSamples = Math.max(chunkMinSamples, Math.round((sampleRateHz * DEBUG_CHUNK_MAX_MS) / 1000));

  const canChunkDump = !state.debugLastChunkDumpMs || now - state.debugLastChunkDumpMs >= DEBUG_CHUNK_INTERVAL_MS;

  if (canChunkDump && samples.length >= chunkMinSamples) {
    state.debugLastChunkDumpMs = now;

    const take = Math.min(samples.length, chunkMaxSamples);
    const chunk = samples.subarray(samples.length - take);

    const chunkStats = computePcmStats(chunk);
    const chunkIndex = (state.debugChunkDumpIndex ?? 0) + 1;
    state.debugChunkDumpIndex = chunkIndex;

    const chunkPath = path.join(dir, `decoded_pcm_chunk_${String(chunkIndex).padStart(4, '0')}.wav`);
    try {
      const wav = encodePcm16ToWav(chunk, sampleRateHz);
      await fs.promises.writeFile(chunkPath, wav);

      log.info(
        {
          event: 'stt_post_decode_chunk',
          encoding,
          sample_rate_hz: sampleRateHz,
          samples: chunk.length,
          ms: Number(((chunk.length / sampleRateHz) * 1000).toFixed(2)),
          rms: Number(chunkStats.rms.toFixed(6)),
          peak: Number(chunkStats.peak.toFixed(6)),
          zero_ratio: Number((countZeroSamples(chunk) / chunk.length).toFixed(6)),
          file_path: chunkPath,
          ...(logContext ?? {}),
        },
        'stt post-decode chunk dump',
      );
    } catch (error) {
      log.warn(
        { event: 'stt_post_decode_chunk_dump_failed', encoding, file_path: chunkPath, err: error, ...(logContext ?? {}) },
        'stt post-decode chunk dump failed',
      );
    }
  }

  /* --------------------- (B) 400ms WINDOW DUMP (best) --------------------- */

  const prevRate = state.debugPcmAccumSampleRateHz;
  if (prevRate && prevRate !== sampleRateHz) {
    state.debugPcmAccum = [];
    state.debugPcmAccumSamples = 0;
    state.debugRollingPcm16 = new Int16Array(0);
  }
  state.debugPcmAccumSampleRateHz = sampleRateHz;

  const window = takeRollingWindowPcm16(state, samples, sampleRateHz, DEBUG_WINDOW_MS);
  if (!window) return;

  const winStats = computePcmStats(window);

  const dumpIndex = (state.debugPcmDumpIndex ?? 0) + 1;
  state.debugPcmDumpIndex = dumpIndex;

  const winPath = path.join(dir, `decoded_pcm_400ms_${String(dumpIndex).padStart(4, '0')}.wav`);
  try {
    const wav = encodePcm16ToWav(window, sampleRateHz);
    await fs.promises.writeFile(winPath, wav);

    log.info(
      {
        event: 'stt_post_decode_400ms',
        encoding,
        sample_rate_hz: sampleRateHz,
        samples: window.length,
        ms: Number(((window.length / sampleRateHz) * 1000).toFixed(2)),
        rms: Number(winStats.rms.toFixed(6)),
        peak: Number(winStats.peak.toFixed(6)),
        zero_ratio: Number((countZeroSamples(window) / window.length).toFixed(6)),
        file_path: winPath,
        ...(logContext ?? {}),
      },
      'stt post-decode 400ms window dump',
    );
  } catch (error) {
    log.warn(
      { event: 'stt_post_decode_dump_failed', encoding, file_path: winPath, err: error, ...(logContext ?? {}) },
      'stt post-decode dump failed',
    );
  }
}

async function maybeDumpPcm16(
  samples: Int16Array,
  sampleRateHz: number,
  encoding: string,
  state: TelnyxCodecState | undefined,
  logContext: Record<string, unknown> | undefined,
): Promise<void> {
  if (!debugPcmDumpEnabled()) return;
  const now = Date.now();
  if (state?.debugLastPcmDumpMs && now - state.debugLastPcmDumpMs < DEBUG_POST_DECODE_INTERVAL_MS) return;
  if (state) state.debugLastPcmDumpMs = now;

  const callId = typeof logContext?.call_control_id === 'string' ? (logContext.call_control_id as string) : 'unknown';
  const dir = debugDir();
  const filePath = path.join(dir, `post_decode_${callId}_${now}.pcm`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    await fs.promises.writeFile(filePath, buffer);
  } catch (error) {
    log.warn(
      { event: 'stt_post_decode_pcm_failed', encoding, file_path: filePath, err: error, ...(logContext ?? {}) },
      'stt post-decode PCM dump failed',
    );
    return;
  }

  const stats = computePcmStats(samples);
  log.info(
    {
      event: 'stt_post_decode_pcm',
      encoding,
      sample_rate_hz: sampleRateHz,
      samples: samples.length,
      rms: Number(stats.rms.toFixed(6)),
      peak: Number(stats.peak.toFixed(6)),
      file_path: filePath,
      ...(logContext ?? {}),
    },
    'stt post-decode pcm',
  );
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
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
  return clampInt16(sample);
}

function aLawToPcmSample(aLawByte: number): number {
  let a = aLawByte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
      break;
  }
  return (a & 0x80) ? clampInt16(t) : clampInt16(-t);
}

function decodePcmu(payload: Buffer): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = muLawToPcmSample(payload[i] as number);
  return out;
}

function decodePcma(payload: Buffer): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = aLawToPcmSample(payload[i] as number);
  return out;
}

function downmixInterleaved(pcm: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    const base = i * channels;
    for (let c = 0; c < channels; c += 1) sum += pcm[base + c] ?? 0;
    out[i] = clampInt16(Math.round(sum / channels));
  }
  return out;
}

export function resamplePcm16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate <= 0 || outputRate <= 0 || input.length === 0) return input;
  if (inputRate === outputRate) return input;

  const outputLength = Math.max(1, Math.round(input.length * (outputRate / inputRate)));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const nextIndex = Math.min(index + 1, input.length - 1);
    const frac = position - index;
    const sample0 = input[index] ?? 0;
    const sample1 = input[nextIndex] ?? sample0;
    output[i] = clampInt16(Math.round(sample0 + (sample1 - sample0) * frac));
  }

  return output;
}

function looksLikeOgg(payload: Buffer): boolean {
  if (payload.length < 4) return false;
  return payload.toString('ascii', 0, 4) === 'OggS';
}

/* ----------------------------- codec normalize ----------------------------- */

function normalizeTelnyxEncoding(raw: string | undefined): { raw: string; normalized: string } {
  const rawValue = (raw ?? '').trim();
  if (!rawValue) return { raw: '', normalized: '' };

  let s = rawValue.toUpperCase();

  const semi = s.indexOf(';');
  if (semi !== -1) s = s.slice(0, semi);

  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    s = parts[parts.length - 1] ?? s;
  }

  s = s.replace(/[.\-]/g, '_');

  const aliases: Record<string, string> = {
    MULAW: 'PCMU',
    ULAW: 'PCMU',
    G711: 'PCMU',
    G711_ULAW: 'PCMU',
    G711U: 'PCMU',
    PCMU: 'PCMU',

    ALAW: 'PCMA',
    G711_ALAW: 'PCMA',
    G711A: 'PCMA',
    PCMA: 'PCMA',

    AMRWB: 'AMR-WB',
    AMR_WB: 'AMR-WB',
    AMR_WB_OA: 'AMR-WB',
    AMR_WB_OCTET_ALIGNED: 'AMR-WB',
    AMR_WB_OCTETALIGNED: 'AMR-WB',
    'AMR-WB': 'AMR-WB',

    G722: 'G722',
    G_722: 'G722',

    OPUS: 'OPUS',
  };

  if (!aliases[s] && s.includes('OPUS')) return { raw: rawValue, normalized: 'OPUS' };
  if (!aliases[s] && s.includes('AMR') && s.includes('WB')) return { raw: rawValue, normalized: 'AMR-WB' };
  if (!aliases[s] && (s.includes('G722') || s.includes('G_722'))) return { raw: rawValue, normalized: 'G722' };
  if (!aliases[s] && (s.includes('PCMU') || s.includes('MULAW') || s.includes('ULAW')))
    return { raw: rawValue, normalized: 'PCMU' };
  if (!aliases[s] && (s.includes('PCMA') || s.includes('ALAW'))) return { raw: rawValue, normalized: 'PCMA' };

  return { raw: rawValue, normalized: aliases[s] ?? s };
}

/* ------------------------------- AMR-WB ---------------------------------- */
/**
 * We support BOTH of these inputs:
 * 1) RTP octet-aligned payloads: [CMR?][TOC...][speech...]
 * 2) AMR-WB storage frames (ffmpeg-friendly): sequence of [TOC(F=0)+speech...] (optionally preceded by "#!AMR-WB\n")
 *
 * This version:
 * - Detects storage-vs-RTP and routes correctly.
 * - Tries transcoder output first (BE preferred), then optional octet fallback.
 * - Forces libopencore_amrwb in ALL ffmpeg decode paths.
 * - Writes runtime_selected_storage as ONE append-only file per call (no byte trimming = no mid-frame corruption).
 *
 * IMPORTANT:
 * - We ONLY append the artifact at the FINAL decode batch (storageForDecode).
 *   Do NOT append earlier “candidate” bytes, because they may include non-speech/special frames or mis-framed bytes.
 */

const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;

const AMRWB_SPEECH_LOST_FT = 14;
const AMRWB_NO_DATA_FT = 15;

function amrWbFrameSize(ft: number): number {
  if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length) return AMRWB_FRAME_SIZES[ft] ?? 0;
  if (ft === 9) return AMRWB_SID_FRAME_BYTES;
  return 0;
}

type AmrWbTocEntry = { ft: number; q: number };

type AmrWbParseError = {
  reason: string;
  invalidFt?: number;
};

type AmrWbFrameKind = 'speech' | 'sid' | 'no_data' | 'speech_lost';

type AmrWbParseResult =
  | {
      ok: true;
      frames: Buffer[];
      frameTypes: AmrWbFrameKind[];
      totalFrames: number;
      decodedFrames: number;
      sidFrames: number;
      noDataFrames: number;
      speechLostFrames: number;
      cmr?: number | null;
    }
  | {
      ok: false;
      error: AmrWbParseError;
      cmr?: number | null;
    };

type AmrWbParseErrorWithOffset = AmrWbParseError & { offset: number };

type AmrWbDepacketizeResult =
  | {
      ok: true;
      storage: Buffer;
      frames: Buffer[];
      frameTypes: AmrWbFrameKind[];
      totalFrames: number;
      mode: 'octet_cmr' | 'octet_no_cmr' | 'storage';
      decodedFrames: number;
      sidFrames: number;
      noDataFrames: number;
      speechLostFrames: number;
      hasSpeechFrames: boolean;
    }
  | {
      ok: false;
      errors: AmrWbParseErrorWithOffset[];
    };

function isAmrWbReservedFt(ft: number): boolean {
  return ft >= 10 && ft <= 13;
}

function ensureAmrWbStreamHeader(buf: Buffer): Buffer {
  if (
    buf.length >= AMRWB_STREAM_HEADER.length &&
    buf.subarray(0, AMRWB_STREAM_HEADER.length).equals(AMRWB_STREAM_HEADER)
  ) {
    return buf;
  }
  return Buffer.concat([AMRWB_STREAM_HEADER, buf]);
}

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
  const f0 = (toc0 & 0x80) !== 0;
  if (f0) return false;

  const ft0 = (toc0 >> 3) & 0x0f;
  if (isAmrWbReservedFt(ft0)) return false;

  const size0 = amrWbFrameSize(ft0);
  if (ft0 === AMRWB_NO_DATA_FT || ft0 === AMRWB_SPEECH_LOST_FT) return true;
  if (size0 <= 0) return false;
  if (b.length < 1 + size0) return false;

  const nextOff = 1 + size0;
  if (b.length > nextOff) {
    const toc1 = b[nextOff] as number;
    if ((toc1 & 0x80) !== 0) return false;
    const ft1 = (toc1 >> 3) & 0x0f;
    if (isAmrWbReservedFt(ft1)) return false;
  }
  return true;
}

function parseAmrWbStorageToFrames(storageBytes: Buffer): AmrWbParseResult {
  const payload = stripAmrWbHeaderIfPresent(storageBytes);
  if (payload.length === 0) return { ok: false, error: { reason: 'empty_storage' }, cmr: null };

  let offset = 0;
  const frames: Buffer[] = [];
  const frameTypes: AmrWbFrameKind[] = [];
  let decodedFrames = 0;
  let sidFrames = 0;
  let noDataFrames = 0;
  let speechLostFrames = 0;

  while (offset < payload.length) {
    const tocRaw = payload[offset++] as number;

    // Storage format MUST have follow bit unset.
    const follow = (tocRaw & 0x80) !== 0;
    if (follow) {
      return { ok: false, error: { reason: 'storage_toc_follow_bit_set' }, cmr: null };
    }

    const ft = (tocRaw >> 3) & 0x0f;
    const q = (tocRaw >> 2) & 0x01;

    if (isAmrWbReservedFt(ft)) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
    }

    // ✅ Normalize TOC: F=0, keep only FT+Q, force pad bits to 0.
    const toc = ((ft & 0x0f) << 3) | ((q & 0x01) << 2);

    if (ft === AMRWB_NO_DATA_FT) {
      frames.push(Buffer.from([toc])); // TOC-only
      frameTypes.push('no_data');
      noDataFrames += 1;
      continue;
    }

    if (ft === AMRWB_SPEECH_LOST_FT) {
      frames.push(Buffer.from([toc])); // TOC-only
      frameTypes.push('speech_lost');
      speechLostFrames += 1;
      continue;
    }

    const size = amrWbFrameSize(ft);

    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) {
        return { ok: false, error: { reason: `sid_overflow_ft_${ft}` }, cmr: null };
      }
      const sid = payload.subarray(offset, offset + size);
      offset += size;

      frames.push(Buffer.concat([Buffer.from([toc]), sid]));
      frameTypes.push('sid');
      sidFrames += 1;
      continue;
    }

    if (size <= 0) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
    }
    if (offset + size > payload.length) {
      return { ok: false, error: { reason: `frame_overflow_ft_${ft}` }, cmr: null };
    }

    const speech = payload.subarray(offset, offset + size);
    offset += size;

    frames.push(Buffer.concat([Buffer.from([toc]), speech]));
    frameTypes.push('speech');
    decodedFrames += 1;
  }

  return {
    ok: true,
    frames,
    frameTypes,
    totalFrames: frameTypes.length,
    decodedFrames,
    sidFrames,
    noDataFrames,
    speechLostFrames,
    cmr: null,
  };
}

function parseAmrWbOctetAlignedToStorageFrames(payload: Buffer, startOffset: number): AmrWbParseResult {
  const cmr = startOffset === 1 ? (payload[0] >> 4) & 0x0f : null;
  if (payload.length === 0) return { ok: false, error: { reason: 'empty' }, cmr };
  if (startOffset >= payload.length) return { ok: false, error: { reason: 'start_offset_out_of_range' }, cmr };

  let offset = startOffset;

  // --- Parse the TOC list (one or more TOC bytes) ---
  const tocEntries: AmrWbTocEntry[] = [];
  let follow = true;

  while (follow && offset < payload.length) {
    const toc = payload[offset++] as number;

    // In RTP octet-aligned, follow bit indicates if another TOC byte follows.
    follow = (toc & 0x80) !== 0;

    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;

    if (isAmrWbReservedFt(ft)) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr };
    }

    tocEntries.push({ ft, q });
  }

  if (tocEntries.length === 0) return { ok: false, error: { reason: 'missing_toc' }, cmr };

  // --- Convert TOC entries + speech bytes into STORAGE FRAMES ---
  const frames: Buffer[] = [];
  const frameTypes: AmrWbFrameKind[] = [];

  let decodedFrames = 0;
  let sidFrames = 0;
  let noDataFrames = 0;
  let speechLostFrames = 0;

  for (const entry of tocEntries) {
    const ft = entry.ft;
    const q = entry.q;

    // Build STORAGE TOC byte: F=0, FT in bits 6..3, Q in bit 2
    // (bits 1..0 are padding/unused here)
    const storageToc = ((ft & 0x0f) << 3) | ((q & 0x01) << 2);

    // Special frames: TOC-only in storage
    if (ft === AMRWB_NO_DATA_FT) {
      frames.push(Buffer.from([storageToc]));
      frameTypes.push('no_data');
      noDataFrames += 1;
      continue;
    }

    if (ft === AMRWB_SPEECH_LOST_FT) {
      frames.push(Buffer.from([storageToc]));
      frameTypes.push('speech_lost');
      speechLostFrames += 1;
      continue;
    }

    const size = amrWbFrameSize(ft);

    // SID (FT=9) -> 5 bytes
    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) {
        return { ok: false, error: { reason: `sid_overflow_ft_${ft}` }, cmr };
      }

      const sid = payload.subarray(offset, offset + size);
      offset += size;

      frames.push(Buffer.concat([Buffer.from([storageToc]), sid]));
      frameTypes.push('sid');
      sidFrames += 1;
      continue;
    }

    // Speech frames
    if (size <= 0) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr };
    }
    if (offset + size > payload.length) {
      return { ok: false, error: { reason: `frame_overflow_ft_${ft}` }, cmr };
    }

    const speech = payload.subarray(offset, offset + size);
    offset += size;

    frames.push(Buffer.concat([Buffer.from([storageToc]), speech]));
    frameTypes.push('speech');
    decodedFrames += 1;
  }

  return {
    ok: true,
    frames,
    frameTypes,
    totalFrames: frameTypes.length,
    decodedFrames,
    sidFrames,
    noDataFrames,
    speechLostFrames,
    cmr,
  };
}

type AmrWbDepacketizeOptions = {
  skipCmr?: boolean;
};

function depacketizeAmrWbToStorage(payload: Buffer, options?: AmrWbDepacketizeOptions): AmrWbDepacketizeResult {
  const errors: AmrWbParseErrorWithOffset[] = [];
  const skipCmr = options?.skipCmr ?? false;

  if (looksLikeAmrWbStorageFrames(payload)) {
    const parsed = parseAmrWbStorageToFrames(payload);
    if (!parsed.ok) return { ok: false, errors: [{ offset: -1, ...parsed.error }] };

    return {
      ok: true,
      storage: Buffer.concat([AMRWB_STREAM_HEADER, ...parsed.frames]),
      frames: parsed.frames,
      frameTypes: parsed.frameTypes,
      totalFrames: parsed.totalFrames,
      mode: 'storage',
      decodedFrames: parsed.decodedFrames,
      sidFrames: parsed.sidFrames,
      noDataFrames: parsed.noDataFrames,
      speechLostFrames: parsed.speechLostFrames,
      hasSpeechFrames: parsed.decodedFrames > 0,
    };
  }

  if (!skipCmr) {
    const withCmr = parseAmrWbOctetAlignedToStorageFrames(payload, 1);
    if (withCmr.ok) {
      return {
        ok: true,
        storage: Buffer.concat([AMRWB_STREAM_HEADER, ...withCmr.frames]),
        frames: withCmr.frames,
        frameTypes: withCmr.frameTypes,
        totalFrames: withCmr.totalFrames,
        mode: 'octet_cmr',
        decodedFrames: withCmr.decodedFrames,
        sidFrames: withCmr.sidFrames,
        noDataFrames: withCmr.noDataFrames,
        speechLostFrames: withCmr.speechLostFrames,
        hasSpeechFrames: withCmr.decodedFrames > 0,
      };
    }
    errors.push({ offset: 1, ...withCmr.error });
  }

  const withoutCmr = parseAmrWbOctetAlignedToStorageFrames(payload, 0);
  if (withoutCmr.ok) {
    return {
      ok: true,
      storage: Buffer.concat([AMRWB_STREAM_HEADER, ...withoutCmr.frames]),
      frames: withoutCmr.frames,
      frameTypes: withoutCmr.frameTypes,
      totalFrames: withoutCmr.totalFrames,
      mode: 'octet_no_cmr',
      decodedFrames: withoutCmr.decodedFrames,
      sidFrames: withoutCmr.sidFrames,
      noDataFrames: withoutCmr.noDataFrames,
      speechLostFrames: withoutCmr.speechLostFrames,
      hasSpeechFrames: withoutCmr.decodedFrames > 0,
    };
  }
  errors.push({ offset: 0, ...withoutCmr.error });

  return { ok: false, errors };
}

/**
 * Writes ONE append-only AMR-WB storage stream per call:
 *   <debugDir>/<callId>/runtime_selected_storage.awb
 *
 * IMPORTANT:
 * - Serialize appends per session to prevent interleaved writes corrupting frames.
 * - Write header once if the file is new/empty.
 */
async function maybeAppendSelectedStorage(
  state: TelnyxCodecState,
  selectedStorageWithHeader: Buffer,
  logContext?: Record<string, unknown>,
): Promise<void> {
  if (!(parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG) || parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB))) return;

  const callId = typeof logContext?.call_control_id === 'string' ? String(logContext.call_control_id) : 'unknown';

  const now = Date.now();
  const minIntervalMs = parseIntEnv('AMRWB_SELECTED_STORAGE_DUMP_INTERVAL_MS', 250);
  if (state.amrwbSelectedStorageLastDumpMs && now - state.amrwbSelectedStorageLastDumpMs < minIntervalMs) return;
  state.amrwbSelectedStorageLastDumpMs = now;

  // append payload only (no header)
  const payload = stripAmrWbHeaderIfPresent(selectedStorageWithHeader);
  if (!payload || payload.length === 0) return;

  const dir = path.join(debugDir(), callId);
  const outPath = path.join(dir, 'runtime_selected_storage.awb');

  const doWrite = async (): Promise<void> => {
    try {
      await fs.promises.mkdir(dir, { recursive: true });

      // Open for read/write (creates if missing). We'll check size to decide header.
      const fh = await fs.promises.open(outPath, 'a+');
      try {
        const st = await fh.stat();
        if (st.size === 0) {
          await fh.write(AMRWB_STREAM_HEADER, 0, AMRWB_STREAM_HEADER.length, null);
        }
        await fh.write(payload, 0, payload.length, null);
      } finally {
        await fh.close();
      }

      if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
        const st2 = await fs.promises.stat(outPath);
        log.info(
          {
            event: 'AMRWB_RUNTIME_SELECTED_APPENDED',
            outPath,
            bytes: st2.size,
            appended_payload_bytes: payload.length,
            ...(logContext ?? {}),
          },
          'AMR-WB runtime selected storage appended',
        );
      }
    } catch (error) {
      log.warn(
        { event: 'amrwb_selected_storage_append_failed', outPath, err: error, ...(logContext ?? {}) },
        'AMR-WB selected storage append failed',
      );
    }
  };

  // ✅ Serialize writes per session/call
  const prev = state.amrwbSelectedStorageWrite ?? Promise.resolve();
  state.amrwbSelectedStorageWrite = prev.then(doWrite, doWrite);
  await state.amrwbSelectedStorageWrite;
}


type PendingRead = {
  bytes: number;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timeoutId?: NodeJS.Timeout;
};

class AmrWbFfmpegStream {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutChunks: Buffer[] = [];
  private stdoutLength = 0;
  private pendingReads: PendingRead[] = [];
  private stderrBuffer = Buffer.alloc(0);
  private closed = false;
  private headerWritten = false;
  private decodeCalls = 0;

  public constructor(private readonly targetSampleRateHz: number) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'amrwb',
      '-c:a',
      'libopencore_amrwb',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(targetSampleRateHz),
      'pipe:1',
    ];

    this.child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.handleStderr(chunk));
    this.child.on('error', (err) => this.handleError(err));
    this.child.on('close', (code, signal) => this.handleClose(code, signal));
  }

  public async decode(frames: Buffer[], decodedFrames: number): Promise<Int16Array> {
    if (decodedFrames <= 0 || frames.length === 0) {
      return new Int16Array(0);
    }
    if (!this.headerWritten) {
      await this.write(AMRWB_STREAM_HEADER);
      this.headerWritten = true;
    }

    const payload = frames.length === 1 ? frames[0]! : Buffer.concat(frames);
    await this.write(payload);
    const timeoutMs = this.decodeCalls === 0 ? 200 : 80;
    this.decodeCalls += 1;

    const samplesPerFrame = Math.max(1, Math.round(this.targetSampleRateHz / AMRWB_FRAME_RATE));
    const expectedSamples = decodedFrames * samplesPerFrame;
    const expectedBytes = expectedSamples * 2;
    if (expectedBytes <= 0) {
      return new Int16Array(0);
    }

    const pcmBuf = await this.readExact(expectedBytes, timeoutMs);
    const pcm = new Int16Array(pcmBuf.length / 2);
    for (let i = 0, j = 0; i < pcmBuf.length; i += 2, j += 1) {
      pcm[j] = pcmBuf.readInt16LE(i);
    }
    return pcm;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.failPending(new Error('ffmpeg stream closed'));
  }

  public stderrSnippet(): string {
    return this.stderrBuffer.toString('utf8');
  }

  private handleStdout(chunk: Buffer): void {
    if (this.closed) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutChunks.push(buf);
    this.stdoutLength += buf.length;
    this.flushReads();
  }

  private handleStderr(chunk: Buffer): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, buf]);
    if (this.stderrBuffer.length > AMRWB_STREAM_STDERR_MAX_BYTES) {
      this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - AMRWB_STREAM_STDERR_MAX_BYTES);
    }
  }

  private handleError(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(err);
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    const message = `ffmpeg stream closed code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    this.failPending(new Error(message));
  }

  private async write(buffer: Buffer): Promise<void> {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('ffmpeg stdin closed');
    }
    const ok = this.child.stdin.write(buffer);
    if (ok) return;

    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        this.child.stdin.off('drain', onDrain);
        this.child.stdin.off('error', onError);
      };
      this.child.stdin.once('drain', onDrain);
      this.child.stdin.once('error', onError);
    });
  }

  private readExact(bytes: number, timeoutMs: number): Promise<Buffer> {
    if (this.closed) {
      return Promise.reject(new Error('ffmpeg stream closed'));
    }
    if (this.stdoutLength >= bytes) {
      return Promise.resolve(this.readFromChunks(bytes));
    }
    return new Promise<Buffer>((resolve, reject) => {
      const entry: PendingRead = { bytes, resolve, reject };
      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          this.removePending(entry);
          reject(new Error('ffmpeg stream read timeout'));
        }, timeoutMs);
      }
      this.pendingReads.push(entry);
    });
  }

  private removePending(entry: PendingRead): void {
    const index = this.pendingReads.indexOf(entry);
    if (index >= 0) this.pendingReads.splice(index, 1);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
  }

  private readFromChunks(bytes: number): Buffer {
    const out = Buffer.allocUnsafe(bytes);
    let remaining = bytes;
    let offset = 0;
    while (remaining > 0) {
      const chunk = this.stdoutChunks[0];
      if (!chunk) break;
      if (chunk.length <= remaining) {
        chunk.copy(out, offset);
        offset += chunk.length;
        remaining -= chunk.length;
        this.stdoutChunks.shift();
      } else {
        chunk.copy(out, offset, 0, remaining);
        this.stdoutChunks[0] = chunk.subarray(remaining);
        offset += remaining;
        remaining = 0;
      }
    }
    this.stdoutLength -= bytes - remaining;
    return remaining === 0 ? out : out.subarray(0, offset);
  }

  private flushReads(): void {
    while (this.pendingReads.length > 0) {
      const next = this.pendingReads[0];
      if (!next || this.stdoutLength < next.bytes) return;
      this.pendingReads.shift();
      if (next.timeoutId) clearTimeout(next.timeoutId);
      const buf = this.readFromChunks(next.bytes);
      next.resolve(buf);
    }
  }

  private failPending(err: Error): void {
    while (this.pendingReads.length > 0) {
      const next = this.pendingReads.shift();
      if (!next) continue;
      if (next.timeoutId) clearTimeout(next.timeoutId);
      next.reject(err);
    }
  }
}

function getAmrWbStream(state: TelnyxCodecState | undefined, targetSampleRateHz: number): AmrWbFfmpegStream | null {
  if (!state || state.amrwbFfmpegStreamDisabled) return null;
  if (parseBoolEnv(process.env.AMRWB_DISABLE_STREAM)) return null;

  if (state.amrwbFfmpegStream && state.amrwbFfmpegStreamRate === targetSampleRateHz) {
    return state.amrwbFfmpegStream;
  }
  if (state.amrwbFfmpegStream) {
    state.amrwbFfmpegStream.close();
  }
  state.amrwbFfmpegStream = new AmrWbFfmpegStream(targetSampleRateHz);
  state.amrwbFfmpegStreamRate = targetSampleRateHz;
  return state.amrwbFfmpegStream;
}

async function decodeAmrWbWithFfmpeg(
  amrwbStorageBytes: Buffer,
  targetSampleRateHz: number,
  logContext?: Record<string, unknown>,
): Promise<{ pcm16: Int16Array; stderr?: string } | null> {
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'amrwb',
      '-c:a',
      'libopencore_amrwb',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(targetSampleRateHz),
      'pipe:1',
    ];

    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on('data', (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on('data', (d) => err.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));

    child.on('error', (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ event: 'amrwb_ffmpeg_spawn_failed', err: msg, ...(logContext ?? {}) }, 'ffmpeg spawn failed');
      resolve(null);
    });

    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        resolve(null);
        return;
      }
      const buf = Buffer.concat(out);
      if (buf.length < 2) {
        resolve(null);
        return;
      }
      const trimmedLen = buf.length - (buf.length % 2);
      const pcm = new Int16Array(trimmedLen / 2);
      for (let i = 0, j = 0; i < trimmedLen; i += 2, j += 1) {
        pcm[j] = buf.readInt16LE(i);
      }
      resolve({ pcm16: pcm, stderr });
    });

    child.stdin.end(amrwbStorageBytes);
  });
}

type AmrCandidate = {
  label: string;
  dep: Extract<AmrWbDepacketizeResult, { ok: true }>;
  sourcePayloadLen: number;
  sourceHexPrefix: string;
};

function scoreCandidate(c: AmrCandidate): number {
  const speech = c.dep.decodedFrames;
  const total = c.dep.totalFrames;
  const penalty = c.dep.noDataFrames + c.dep.speechLostFrames + c.dep.sidFrames;
  const modeBonus = c.dep.mode === 'storage' ? 2 : 0;
  return speech * 10 + Math.max(0, total - penalty) + modeBonus;
}

/* ---------------------------------- main ---------------------------------- */

export async function decodeTelnyxPayloadToPcm16(opts: DecodeTelnyxOptions): Promise<DecodeTelnyxResult | null> {
  const enc = normalizeTelnyxEncoding(opts.encoding);
  const encoding = enc.normalized;

  const state = getOrCreateSessionState(opts.state, opts.logContext);

  const targetRate = opts.targetSampleRateHz;
  const channels = opts.channels ?? 1;

  if (!state.ingestLogged) {
    state.ingestLogged = true;
    log.info(
      {
        event: 'stt_codec_probe',
        raw_encoding: enc.raw,
        normalized_encoding: encoding,
        channels,
        reported_sample_rate_hz: opts.reportedSampleRateHz,
        payload_len: opts.payload.length,
        target_sample_rate_hz: targetRate,
        ...(opts.logContext ?? {}),
      },
      'STT codec probe',
    );
  }

  if (encoding === 'PCMU') {
    const pcm = decodePcmu(opts.payload);
    const resampled = resamplePcm16(pcm, 8000, targetRate);
    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  if (encoding === 'PCMA') {
    const pcm = decodePcma(opts.payload);
    const resampled = resamplePcm16(pcm, 8000, targetRate);
    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  // AMR-WB
  if (encoding === 'AMR-WB') {
    if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
      log.info({ event: 'amrwb_code_path_reached', encoding, ...(opts.logContext ?? {}) }, 'AMR-WB decode path reached');
    }

    if (!opts.allowAmrWb) return null;

    const candidates: AmrCandidate[] = [];

    // 1) Run transcoder FIRST
    const transcode = transcodeTelnyxAmrWbPayload(opts.payload);

    // --- AMR-WB artifact capture ---
    if (parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB) || parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG)) {
      writeAmrwbArtifacts('amrwb_raw_payload', opts.payload, {
        hasCmr: true,
        meta: {
          encoding,
          payload_len: opts.payload.length,
          ...(opts.logContext ?? {}),
        },
      });

      if (transcode.ok) {
        writeAmrwbArtifacts('amrwb_transcoded_output', transcode.output, {
          hasCmr: transcode.cmrStripped !== true,
          meta: {
            packing: transcode.packing,
            rtp_stripped: transcode.rtpStripped,
            toc_count: transcode.tocCount,
            cmr: transcode.cmr ?? null,
            cmr_stripped: transcode.cmrStripped ?? null,
            total_bytes_in: transcode.totalBytesIn,
            total_bytes_out: transcode.totalBytesOut,
            ...(opts.logContext ?? {}),
          },
        });
      }
    }
    // --- end artifact capture ---

    const envDefaultBe = parseBoolEnv(process.env.TELNYX_AMRWB_DEFAULT_BE);
    const forcedBe = opts.forceAmrWbBe === true;
    const beActive = forcedBe || envDefaultBe || (transcode.ok && transcode.packing === 'be');

    // IMPORTANT: if BE is active, we do NOT allow octet fallback.
    const octetFallbackAllowed = !beActive && parseBoolEnv(process.env.AMRWB_ALLOW_OCTET_FALLBACK);

    const logPathSelectOnce = (chosenPath: 'be' | 'octet'): void => {
      if (state.amrwbPathSelectedLogged) return;
      state.amrwbPathSelectedLogged = true;
      log.info(
        {
          event: 'amrwb_path_select',
          be_active: beActive,
          forced_be: forcedBe,
          env_default_be: envDefaultBe,
          transcode_packing: transcode.ok ? transcode.packing : 'transcode_failed',
          cmr_stripped: transcode.ok ? Boolean(transcode.cmrStripped) : null,
          fallback_allowed: octetFallbackAllowed,
          chosen_path: chosenPath,
          ...(opts.logContext ?? {}),
        },
        'AMR-WB path selected',
      );
    };

    if (!transcode.ok) {
      const invalidCount = (state.amrwbDepackInvalidCount ?? 0) + 1;
      state.amrwbDepackInvalidCount = invalidCount;

      if (invalidCount <= 10) {
        const hexPrefix = opts.payload.subarray(0, Math.min(32, opts.payload.length)).toString('hex');
        log.warn(
          {
            event: 'amrwb_depack_invalid',
            reason: transcode.error,
            payload_len: opts.payload.length,
            first_bytes_hex: hexPrefix,
            rtp_stripped: transcode.rtpStripped,
            forced_be: forcedBe,
            env_default_be: envDefaultBe,
            be_active: beActive,
            ...(opts.logContext ?? {}),
          },
          `AMRWB_DEPACK invalid reason=${transcode.error} firstBytesHex=${hexPrefix} len=${opts.payload.length}`,
        );
      }

      state.amrwbLastError = 'amrwb_depack_invalid';

      if (beActive) {
        state.amrwbLastError = 'amrwb_be_transcode_failed';
        logPathSelectOnce('be');
        return null;
      }
    } else {
      if (!state.amrwbDepacketizeLogged) {
        state.amrwbDepacketizeLogged = true;
        log.info(
          {
            event: 'amrwb_depack',
            packing: transcode.packing,
            rtp_stripped: transcode.rtpStripped,
            toc_count: transcode.tocCount,
            cmr_stripped: transcode.cmrStripped ?? false,
            total_bytes_in: transcode.totalBytesIn,
            total_bytes_out: transcode.totalBytesOut,
            forced_be: forcedBe,
            env_default_be: envDefaultBe,
            be_active: beActive,
            ...(opts.logContext ?? {}),
          },
          `AMRWB_DEPACK packing=${transcode.packing} rtpStripped=${transcode.rtpStripped} tocCount=${transcode.tocCount} cmrStripped=${Boolean(
            transcode.cmrStripped,
          )} totalBytesIn=${transcode.totalBytesIn} totalBytesOut=${transcode.totalBytesOut}`,
        );
      }

      // Some transcoder outputs are not already storage-framed; they may still be octet-ish.
      // We accept either and convert to storage frames consistently.
      let depStorage: Extract<AmrWbDepacketizeResult, { ok: true }> | null = null;

      // Case A: transcoder output already looks like STORAGE frames (with or without header)
      if (
        looksLikeAmrWbStorageFrames(transcode.output) ||
        looksLikeAmrWbStorageFrames(ensureAmrWbStreamHeader(transcode.output))
      ) {
        const storageBytes = ensureAmrWbStreamHeader(transcode.output);
        const parsedStorage = parseAmrWbStorageToFrames(storageBytes);

        if (parsedStorage.ok) {
          // ✅ Only accept as a candidate if it contains actual speech frames
          if (parsedStorage.decodedFrames > 0) {
            depStorage = {
              ok: true,
              storage: storageBytes,
              frames: parsedStorage.frames,
              frameTypes: parsedStorage.frameTypes,
              totalFrames: parsedStorage.totalFrames,
              mode: 'storage',
              decodedFrames: parsedStorage.decodedFrames,
              sidFrames: parsedStorage.sidFrames,
              noDataFrames: parsedStorage.noDataFrames,
              speechLostFrames: parsedStorage.speechLostFrames,
              hasSpeechFrames: true,
            };
          } else if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
            log.info(
              {
                event: 'amrwb_transcoded_no_speech',
                total_frames: parsedStorage.totalFrames,
                decoded_frames: parsedStorage.decodedFrames,
                sid_frames: parsedStorage.sidFrames,
                no_data_frames: parsedStorage.noDataFrames,
                speech_lost_frames: parsedStorage.speechLostFrames,
                ...(opts.logContext ?? {}),
              },
              'AMR-WB transcoded chunk had no speech; ignored',
            );
          }
        } else {
          if (!state.amrwbDepacketizeFailedLogged) {
            state.amrwbDepacketizeFailedLogged = true;
            log.warn(
              {
                event: 'amrwb_transcoded_storage_parse_failed',
                reason: parsedStorage.error.reason,
                invalid_ft: parsedStorage.error.invalidFt ?? null,
                payload_len: transcode.output.length,
                packing: transcode.packing,
                cmr_stripped: transcode.cmrStripped ?? false,
                hex_prefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
                ...(opts.logContext ?? {}),
              },
              'AMR-WB transcoded output looked like storage but did not parse',
            );
          }
        }
      } else {
        // Case B: treat transcoder output as octet-ish (NO CMR) and convert -> storage frames.
        const parsed = parseAmrWbOctetAlignedToStorageFrames(transcode.output, 0);

        if (parsed.ok) {
          // ✅ Only accept as a candidate if it contains actual speech frames
          if (parsed.decodedFrames > 0) {
            const storageBytes = Buffer.concat([AMRWB_STREAM_HEADER, ...parsed.frames]);

            depStorage = {
              ok: true,
              storage: storageBytes,
              frames: parsed.frames,
              frameTypes: parsed.frameTypes,
              totalFrames: parsed.totalFrames,
              mode: 'storage', // it is now true storage frames
              decodedFrames: parsed.decodedFrames,
              sidFrames: parsed.sidFrames,
              noDataFrames: parsed.noDataFrames,
              speechLostFrames: parsed.speechLostFrames,
              hasSpeechFrames: true,
            };
          } else if (parseBoolEnv(process.env.AMRWB_DECODE_TRACE)) {
            log.info(
              {
                event: 'amrwb_transcoded_no_speech',
                total_frames: parsed.totalFrames,
                decoded_frames: parsed.decodedFrames,
                sid_frames: parsed.sidFrames,
                no_data_frames: parsed.noDataFrames,
                speech_lost_frames: parsed.speechLostFrames,
                ...(opts.logContext ?? {}),
              },
              'AMR-WB transcoded chunk had no speech; ignored',
            );
          }
        } else {
          if (!state.amrwbDepacketizeFailedLogged) {
            state.amrwbDepacketizeFailedLogged = true;
            log.warn(
              {
                event: 'amrwb_transcoded_storage_parse_failed',
                reason: parsed.error.reason,
                invalid_ft: parsed.error.invalidFt ?? null,
                payload_len: transcode.output.length,
                packing: transcode.packing,
                cmr_stripped: transcode.cmrStripped ?? false,
                hex_prefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
                ...(opts.logContext ?? {}),
              },
              'AMR-WB transcoded output did not parse/convert to storage frames',
            );
          }
        }
      }

      if (depStorage) {
        candidates.push({
          label: 'transcoded',
          dep: depStorage,
          sourcePayloadLen: transcode.output.length,
          sourceHexPrefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
        });
      } else {
        if (beActive) {
          state.amrwbLastError = 'amrwb_be_storage_parse_failed';
          logPathSelectOnce('be');
          return null;
        }
      }
    }

    // Optional octet fallback (only if BE is inactive and env enables it)
    if (octetFallbackAllowed) {
      const rawDep = depacketizeAmrWbToStorage(opts.payload, { skipCmr: false });
      if (rawDep.ok) {
        candidates.push({
          label: 'raw',
          dep: rawDep,
          sourcePayloadLen: opts.payload.length,
          sourceHexPrefix: opts.payload.subarray(0, Math.min(32, opts.payload.length)).toString('hex'),
        });
      }
    }

    if (candidates.length === 0) {
      logPathSelectOnce(beActive ? 'be' : 'octet');
      state.amrwbLastError = state.amrwbLastError ?? 'amrwb_no_candidates';
      return null;
    }

    // Filter broken candidates
    const headerLen = AMRWB_STREAM_HEADER.length;
    const valid = candidates.filter((c) => {
      if (!c.dep.storage || c.dep.storage.length <= headerLen) return false;
      if (!c.dep.frames || c.dep.frames.length === 0) return false;
      if (c.dep.decodedFrames > 0 && c.dep.hasSpeechFrames !== true) return false;
      return true;
    });

    if (valid.length === 0) {
      state.amrwbLastError = 'amrwb_no_valid_candidates';
      return null;
    }

    candidates.length = 0;
    candidates.push(...valid);

    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const transcodedCandidate = candidates.find((candidate) => candidate.label === 'transcoded');
    const chosen = transcodedCandidate ?? candidates[0]!;
    const dep = chosen.dep;

    const chosenPath = chosen.label === 'raw' ? 'octet' : transcode.ok && transcode.packing === 'be' ? 'be' : 'octet';

    logPathSelectOnce(chosenPath);

    if (chosen.label === 'raw' && !state.amrwbFallbackLogged) {
      state.amrwbFallbackLogged = true;
      log.warn(
        {
          event: 'amrwb_fallback_used',
          chosen_mode: dep.mode,
          payload_len: opts.payload.length,
          transcode_packing: transcode.ok ? transcode.packing : 'transcode_failed',
          ...(opts.logContext ?? {}),
        },
        'AMR-WB octet fallback used',
      );
    }

    if (!dep.storage || dep.storage.length <= AMRWB_STREAM_HEADER.length) {
      log.error(
        { event: 'AMRWB_CHOSEN_INVALID_STORAGE', storage_len: dep.storage?.length ?? -1, ...(opts.logContext ?? {}) },
        'Chosen AMR-WB candidate had invalid storage',
      );
      return null;
    }

    // -------------------- BUFFER AMR-WB FRAMES (critical fix) --------------------
    // We DO NOT decode per packet. We accumulate storage frames and decode in batches.

    if (!state.amrwbFrameBuf) state.amrwbFrameBuf = [];
    if (!state.amrwbFrameBufDecodedFrames) state.amrwbFrameBufDecodedFrames = 0;

    // Buffer ONLY speech frames (ft 0..8). Do NOT feed SID/NO_DATA/SPEECH_LOST into ffmpeg,
    // because the stream reader expects bytes based on speech-frame count.
    for (let i = 0; i < dep.frames.length; i += 1) {
      if (dep.frameTypes[i] !== 'speech') continue;

      const frame = dep.frames[i]!;
      if (!frame || frame.length < 2) {
        // Drop malformed "speech" frames (this is what causes AMR frame too short (1,...))
        continue;
      }

      // Validate expected length based on FT encoded in the TOC byte
      const toc = frame[0]!;
      const ft = (toc >> 3) & 0x0f;
      const expected = 1 + amrWbFrameSize(ft);

      // Speech frames must match exact size (TOC + speech payload)
      if (expected <= 1 || frame.length !== expected) {
        continue;
      }

      state.amrwbFrameBuf.push(frame);
      state.amrwbFrameBufDecodedFrames = (state.amrwbFrameBufDecodedFrames ?? 0) + 1;
    }

    // ✅ BUFFER AGE TIMER FIX:
    // Start the timer when we first accumulate speech frames; flush either when we have enough
    // frames OR when the buffer has been accumulating too long.
    const now = Date.now();
    if ((state.amrwbFrameBufDecodedFrames ?? 0) > 0 && !state.amrwbFrameBufLastFlushMs) {
      state.amrwbFrameBufLastFlushMs = now; // treat as buffer start time
    }

    const bufStart = state.amrwbFrameBufLastFlushMs ?? 0;
    const ageMs = bufStart ? now - bufStart : 0;

    const minFrames =
      Number.isFinite(AMRWB_MIN_DECODE_FRAMES) && AMRWB_MIN_DECODE_FRAMES > 0 ? AMRWB_MIN_DECODE_FRAMES : 10;
    const maxBufferMs =
      Number.isFinite(AMRWB_MAX_BUFFER_MS) && AMRWB_MAX_BUFFER_MS > 0 ? AMRWB_MAX_BUFFER_MS : 500;

    const haveEnough = (state.amrwbFrameBufDecodedFrames ?? 0) >= minFrames;
    const tooOld = bufStart !== 0 && ageMs >= maxBufferMs;

    // Not enough audio accumulated yet -> don't decode yet.
    // IMPORTANT: return null so upstream doesn't feed Whisper empty audio.
    if (!haveEnough && !tooOld) {
      return null;
    }

    // Flush buffer -> build a valid .awb stream for ffmpeg
    const framesToDecode = state.amrwbFrameBuf;
    const decodedFramesToDecode = state.amrwbFrameBufDecodedFrames ?? 0;

    state.amrwbFrameBuf = [];
    state.amrwbFrameBufDecodedFrames = 0;
    state.amrwbFrameBufLastFlushMs = 0; // ✅ reset; next batch starts its own timer

    if (!framesToDecode || framesToDecode.length === 0 || decodedFramesToDecode <= 0) {
      return null;
    }

    const storageForDecode = Buffer.concat([AMRWB_STREAM_HEADER, ...framesToDecode]);

    // ✅ ONLY append the artifact for the FINAL decode batch (never earlier candidate bytes)
    await maybeAppendSelectedStorage(state, storageForDecode, opts.logContext);

    // ----------------------------- DECODE (FFMPEG) -----------------------------
    const samplesPerFrame = Math.max(1, Math.round(targetRate / AMRWB_FRAME_RATE));

    let decoded: { pcm16: Int16Array } | null = null;
    let usedStream = false;
    const stream = getAmrWbStream(state, targetRate);

    if (stream) {
      try {
        const pcm16 = await stream.decode(framesToDecode, decodedFramesToDecode);
        if (pcm16.length > 0) {
          decoded = { pcm16 };
          usedStream = true;
          state.amrwbFfmpegUsable = true;
          state.amrwbLastError = undefined;
        }
      } catch (error) {
        state.amrwbFfmpegStreamDisabled = true;
        state.amrwbFfmpegUsable = false;
        state.amrwbLastError = 'amrwb_ffmpeg_stream_failed';
        stream.close();
        state.amrwbFfmpegStream = undefined;
        state.amrwbFfmpegStreamRate = undefined;

        log.warn(
          {
            event: 'amrwb_ffmpeg_stream_failed',
            stderr: stream.stderrSnippet(),
            err: error,
            ...(opts.logContext ?? {}),
          },
          'AMR-WB ffmpeg stream decode failed',
        );
      }
    }

    if (!decoded || decoded.pcm16.length === 0) {
      const oneShot = await decodeAmrWbWithFfmpeg(storageForDecode, targetRate, opts.logContext);
      if (!oneShot || oneShot.pcm16.length === 0) {
        state.amrwbFfmpegUsable = false;
        state.amrwbLastError = 'amrwb_ffmpeg_decode_failed';
        return null;
      }
      decoded = { pcm16: oneShot.pcm16 };
    }

    // strict check based on what we DECIDED to decode (batch)
    const expectedSpeechSamples = decodedFramesToDecode * samplesPerFrame;
    if (amrwbStrictDecodeEnabled() && decoded.pcm16.length < expectedSpeechSamples) {
      state.amrwbLastError = 'amrwb_short_pcm';
      return null;
    }

    const decodedRawSamples = decoded.pcm16.length;
    const actualSamples = decoded.pcm16.length;
    const zeroCount = countZeroSamples(decoded.pcm16);
    const zeroRatio = actualSamples > 0 ? zeroCount / actualSamples : 1;
    const decodedStats = computePcmStats(decoded.pcm16);
    const dropout = zeroRatio > 0.9 || decodedStats.rms < 0.001 || decodedRawSamples < expectedSpeechSamples;

    if (shouldLogAmrwbDebug(state, Date.now(), dropout)) {
      const prefixSamples = Array.from(decoded.pcm16.subarray(0, 16));
      const prefixBuf = Buffer.from(
        decoded.pcm16.buffer,
        decoded.pcm16.byteOffset,
        Math.min(32, decoded.pcm16.byteLength),
      );

      log.info(
        {
          event: 'amrwb_decode_debug',
          decode_source: chosen.label,
          mode: dep.mode,
          decoded_frames: decodedFramesToDecode,
          total_frames: decodedFramesToDecode, // batch total speech frames
          sample_rate_hz: targetRate,
          expected_speech_samples: expectedSpeechSamples,
          decoded_raw_samples: decodedRawSamples,
          samples: actualSamples,
          zero_samples: zeroCount,
          zero_ratio: Number(zeroRatio.toFixed(6)),
          rms: Number(decodedStats.rms.toFixed(6)),
          peak: Number(decodedStats.peak.toFixed(6)),
          dropout,
          decode_path: usedStream ? 'ffmpeg_stream' : 'ffmpeg',
          pcm_prefix_samples: prefixSamples,
          pcm_prefix_hex: prefixBuf.toString('hex'),
          ...(opts.logContext ?? {}),
        },
        'AMR-WB decode debug',
      );
    }

    state.amrwbFfmpegUsable = true;
    state.amrwbLastError = undefined;

    await maybeDumpPostDecode(decoded.pcm16, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(decoded.pcm16, targetRate, encoding, state, opts.logContext);

    return {
      pcm16: decoded.pcm16,
      sampleRateHz: targetRate,
      decodedFrames: decodedFramesToDecode,
      decodeFailures: 0,
    };
  }

  // G.722
  if (encoding === 'G722') {
    if (!opts.allowG722) return null;
    if (!state.g722) state.g722 = new G722Decoder(64000, 0);
    const decoded = state.g722.decode(opts.payload);

    const resampled = resamplePcm16(decoded, 16000, targetRate);
    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  // OPUS
  if (encoding === 'OPUS') {
    if (!opts.allowOpus) return null;

    if (looksLikeOgg(opts.payload)) {
      log.warn(
        { event: 'opus_container_detected', encoding, length: opts.payload.length, ...(opts.logContext ?? {}) },
        'Opus payload appears to be Ogg; expected raw Opus packets',
      );
      return null;
    }

    if ((!state.opus || state.opusChannels !== channels) && !state.opusFailed) {
      try {
        state.opus = new OpusPacketDecoder(channels);
        state.opusChannels = channels;
      } catch (error) {
        state.opusFailed = true;
        log.warn({ err: error, event: 'opus_decoder_init_failed', ...(opts.logContext ?? {}) }, 'Opus decoder init failed');
        return null;
      }
    }

    if (!state.opus || state.opusFailed) return null;

    let pcm = new Int16Array(0);
    try {
      const decoded = state.opus.decode(opts.payload);
      const mono = downmixInterleaved(decoded, channels);
      pcm = new Int16Array(mono);
    } catch (error) {
      log.warn({ err: error, event: 'opus_decode_failed', ...(opts.logContext ?? {}) }, 'Opus decode failed');
      return null;
    }

    const inputRate = DEFAULT_OPUS_SAMPLE_RATE;
    const resampled =
      inputRate === 48000 && targetRate === 16000 ? resample48kTo16k(pcm) : resamplePcm16(pcm, inputRate, targetRate);

    if (!state.opusLogged) {
      state.opusLogged = true;
      log.info(
        {
          event: 'opus_decode_success',
          input_bytes: opts.payload.length,
          input_rate_hz: inputRate,
          output_rate_hz: targetRate,
          decoded_samples: pcm.length,
          output_samples: resampled.length,
          ...(opts.logContext ?? {}),
        },
        'Opus packet decoded',
      );
    }

    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  return null;
}

export function closeTelnyxCodecState(state?: TelnyxCodecState): void {
  if (!state?.amrwbFfmpegStream) return;
  state.amrwbFfmpegStream.close();
  state.amrwbFfmpegStream = undefined;
  state.amrwbFfmpegStreamRate = undefined;
}

/**
 * Clears the cached session state (when caller did not provide a state object).
 * Call this when a Telnyx call ends, using the same logContext that contains call_control_id.
 */
export function clearTelnyxCodecSession(logContext?: Record<string, unknown>): void {
  const key = getSessionKey(logContext);
  if (!key) return;

  const st = SESSION_STATE_CACHE.get(key);
  if (st?.amrwbFfmpegStream) {
    st.amrwbFfmpegStream.close();
  }
  SESSION_STATE_CACHE.delete(key);
}
