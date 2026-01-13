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
}

export interface DecodeTelnyxOptions {
  encoding: string;
  payload: Buffer;
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
const AMRWB_STREAM_HEADER = Buffer.from('#!AMR-WB\n', 'ascii');
const AMRWB_FRAME_RATE = 50;
const AMRWB_STREAM_STDERR_MAX_BYTES = 4096;
const AMRWB_DEBUG_MAX_FRAMES = 30;
const AMRWB_DEBUG_MAX_DROPOUTS = 50;
const AMRWB_DEBUG_INTERVAL_MS = 1000;

/* ---------------------------------- utils --------------------------------- */

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function debugPostDecodeEnabled(): boolean {
  return (
    parseBoolEnv(process.env.TELNYX_DEBUG_TAP_POST_DECODE) ||
    parseBoolEnv(process.env.STT_DEBUG_DUMP_POST_DECODE)
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

async function maybeDumpPostDecode(
  samples: Int16Array,
  sampleRateHz: number,
  encoding: string,
  state: TelnyxCodecState | undefined,
  logContext: Record<string, unknown> | undefined,
): Promise<void> {
  if (!debugPostDecodeEnabled()) return;
  if (!state) return;

  const callId =
    typeof logContext?.call_control_id === 'string' ? (logContext.call_control_id as string) : 'unknown';
  const targetSamples = Math.max(1, Math.round(sampleRateHz * 0.4));
  const currentRate = state.debugPcmAccumSampleRateHz;

  if (currentRate && currentRate !== sampleRateHz) {
    state.debugPcmAccum = [];
    state.debugPcmAccumSamples = 0;
  }
  state.debugPcmAccumSampleRateHz = sampleRateHz;

  if (!state.debugPcmAccum) state.debugPcmAccum = [];
  state.debugPcmAccum.push(samples);
  state.debugPcmAccumSamples = (state.debugPcmAccumSamples ?? 0) + samples.length;

  if (state.debugPcmAccumSamples < targetSamples) return;

  const combined = new Int16Array(state.debugPcmAccumSamples);
  let combinedOffset = 0;
  for (const chunk of state.debugPcmAccum) {
    combined.set(chunk, combinedOffset);
    combinedOffset += chunk.length;
  }

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

  let cursor = 0;
  let dumpIndex = state.debugPcmDumpIndex ?? 0;
  while (combined.length - cursor >= targetSamples) {
    dumpIndex += 1;
    const slice = combined.subarray(cursor, cursor + targetSamples);
    const filePath = path.join(dir, `decoded_pcm_400ms_${String(dumpIndex).padStart(3, '0')}.wav`);
    try {
      const wav = encodePcm16ToWav(slice, sampleRateHz);
      await fs.promises.writeFile(filePath, wav);
    } catch (error) {
      log.warn(
        { event: 'stt_post_decode_dump_failed', encoding, file_path: filePath, err: error, ...(logContext ?? {}) },
        'stt post-decode dump failed',
      );
      return;
    }

    const stats = computePcmStats(slice);
    log.info(
      {
        event: 'stt_post_decode',
        encoding,
        sample_rate_hz: sampleRateHz,
        samples: slice.length,
        rms: Number(stats.rms.toFixed(6)),
        peak: Number(stats.peak.toFixed(6)),
        file_path: filePath,
        ...(logContext ?? {}),
      },
      'stt post-decode dump',
    );

    cursor += targetSamples;
  }

  const remaining = combined.length - cursor;
  if (remaining > 0) {
    const leftover = new Int16Array(remaining);
    leftover.set(combined.subarray(cursor));
    state.debugPcmAccum = [leftover];
    state.debugPcmAccumSamples = remaining;
  } else {
    state.debugPcmAccum = [];
    state.debugPcmAccumSamples = 0;
  }
  state.debugPcmDumpIndex = dumpIndex;
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

  const callId =
    typeof logContext?.call_control_id === 'string' ? (logContext.call_control_id as string) : 'unknown';
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
 * The bug you were seeing (robotic/crunchy) is consistent with “double parsing”:
 * a helper might already output storage frames, and then we try to depacketize again as RTP.
 *
 * This version:
 * - Detects storage-vs-RTP and routes correctly.
 * - Tries raw payload and transcoder output, then selects the best candidate.
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
  // AMR-WB reserved frame types are 10..13.
  // FT=14 is SPEECH_LOST (valid), FT=15 is NO_DATA (valid).
  return ft >= 10 && ft <= 13;
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

  // Storage frames have TOC bytes with F=0 (bit7 = 0). RTP TOC entries may have F=1 for multiple TOCs.
  // This is heuristic, but catches the “already storage” case reliably.
  const toc0 = b[0] as number;
  const f0 = (toc0 & 0x80) !== 0;
  if (f0) return false;

  const ft0 = (toc0 >> 3) & 0x0f;
  if (isAmrWbReservedFt(ft0)) return false;
  const size0 = amrWbFrameSize(ft0);
  if (ft0 === AMRWB_NO_DATA_FT || ft0 === AMRWB_SPEECH_LOST_FT) {
    // Valid, zero length in storage. Accept.
    return true;
  }
  if (size0 <= 0) return false;
  if (b.length < 1 + size0) return false;

  // Also check that the next TOC (if any) is plausible.
  const nextOff = 1 + size0;
  if (b.length > nextOff) {
    const toc1 = b[nextOff] as number;
    if ((toc1 & 0x80) !== 0) return false; // would imply RTP multi-TOC.
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
    const toc = payload[offset++] as number;
    const follow = (toc & 0x80) !== 0;
    if (follow) {
      // Storage format expects F=0 always.
      return { ok: false, error: { reason: 'storage_toc_follow_bit_set' }, cmr: null };
    }

    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;
    void q;

    if (isAmrWbReservedFt(ft)) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
    }

    if (ft === AMRWB_NO_DATA_FT) {
      frameTypes.push('no_data');
      noDataFrames += 1;
      // no bytes follow
      continue;
    }

    if (ft === AMRWB_SPEECH_LOST_FT) {
      frameTypes.push('speech_lost');
      speechLostFrames += 1;
      // no bytes follow
      continue;
    }

    const size = amrWbFrameSize(ft);

    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) {
        return { ok: false, error: { reason: `sid_overflow_ft_${ft}` }, cmr: null };
      }
      // Keep the frame for ffmpeg (it can handle SID), but treat as sid.
      const speech = payload.subarray(offset, offset + size);
      offset += size;
      frames.push(Buffer.concat([Buffer.from([toc]), speech]));
      frameTypes.push('sid');
      sidFrames += 1;
      continue;
    }

    if (size <= 0) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr: null };
    }
    if (offset + size > payload.length) {
      return { ok: false, error: `frame_overflow_ft_${ft}` as unknown as AmrWbParseError, cmr: null };
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
  // payload[0] is CMR when startOffset === 1 (octet-aligned mode).
  const cmr = startOffset === 1 ? (payload[0] >> 4) & 0x0f : null;
  if (payload.length === 0) return { ok: false, error: { reason: 'empty' }, cmr };
  if (startOffset >= payload.length) return { ok: false, error: { reason: 'start_offset_out_of_range' }, cmr };

  let offset = startOffset;
  const tocEntries: AmrWbTocEntry[] = [];
  let follow = true;

  while (follow && offset < payload.length) {
    const toc = payload[offset++] as number;
    follow = (toc & 0x80) !== 0;
    const ft = (toc >> 3) & 0x0f;
    const q = (toc >> 2) & 0x01;

    if (isAmrWbReservedFt(ft)) {
      return { ok: false, error: { reason: `invalid_ft_${ft}`, invalidFt: ft }, cmr };
    }

    tocEntries.push({ ft, q });
  }

  if (tocEntries.length === 0) return { ok: false, error: { reason: 'missing_toc' }, cmr };

  const frames: Buffer[] = [];
  let decodedFrames = 0;
  let sidFrames = 0;
  let noDataFrames = 0;
  let speechLostFrames = 0;
  const frameTypes: AmrWbFrameKind[] = [];

  for (const entry of tocEntries) {
    if (entry.ft === AMRWB_NO_DATA_FT) {
      noDataFrames += 1;
      frameTypes.push('no_data');
      continue;
    }
    if (entry.ft === AMRWB_SPEECH_LOST_FT) {
      speechLostFrames += 1;
      frameTypes.push('speech_lost');
      continue;
    }

    const size = amrWbFrameSize(entry.ft);

    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) {
        return { ok: false, error: { reason: `sid_overflow_ft_${entry.ft}` }, cmr };
      }
      // Skip SID bytes in RTP mode (historically you were skipping).
      // NOTE: this is fine; we still include silence later if needed.
      offset += size;
      sidFrames += 1;
      frameTypes.push('sid');
      continue;
    }

    if (size <= 0) {
      return { ok: false, error: { reason: `invalid_ft_${entry.ft}`, invalidFt: entry.ft }, cmr };
    }
    if (offset + size > payload.length) {
      return { ok: false, error: { reason: `frame_overflow_ft_${entry.ft}` }, cmr };
    }

    const speech = payload.subarray(offset, offset + size);
    offset += size;

    // Storage TOC byte: F=0, FT=ft, Q=1, P=0
    const tocByte = ((entry.ft & 0x0f) << 3) | (1 << 2);
    frames.push(Buffer.concat([Buffer.from([tocByte]), speech]));
    decodedFrames += 1;
    frameTypes.push('speech');
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

  // If it already looks like storage frames, do NOT try to interpret as RTP.
  if (looksLikeAmrWbStorageFrames(payload)) {
    const parsed = parseAmrWbStorageToFrames(payload);
    if (!parsed.ok) {
      return { ok: false, errors: [{ offset: -1, ...parsed.error }] };
    }
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
      hasSpeechFrames: parsed.frames.length > 0,
    };
  }

  if (!skipCmr) {
    // Try octet-aligned with CMR at [0]
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
        hasSpeechFrames: withCmr.frames.length > 0,
      };
    }
    errors.push({ offset: 1, ...withCmr.error });
  }

  // Try without CMR
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
      hasSpeechFrames: withoutCmr.frames.length > 0,
    };
  }
  errors.push({ offset: 0, ...withoutCmr.error });

  return { ok: false, errors };
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

function expandAmrWbPcmWithSilence(pcm16: Int16Array, frameTypes: AmrWbFrameKind[], samplesPerFrame: number): Int16Array {
  if (frameTypes.length === 0 || samplesPerFrame <= 0) return pcm16;
  const totalSamples = frameTypes.length * samplesPerFrame;
  if (totalSamples <= 0) return pcm16;

  const expanded = new Int16Array(totalSamples);
  let speechOffset = 0;
  let outOffset = 0;
  for (const kind of frameTypes) {
    if (kind === 'speech') {
      const slice = pcm16.subarray(speechOffset, speechOffset + samplesPerFrame);
      expanded.set(slice, outOffset);
      speechOffset += samplesPerFrame;
    }
    outOffset += samplesPerFrame;
  }

  return expanded;
}

function getAmrWbStream(state: TelnyxCodecState | undefined, targetSampleRateHz: number): AmrWbFfmpegStream | null {
  if (!state || state.amrwbFfmpegStreamDisabled) return null;
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
  // Prefer more speech, fewer non-speech frames. (Sid/no_data/speech_lost are “less useful” for STT.)
  const speech = c.dep.decodedFrames;
  const total = c.dep.totalFrames;
  const penalty = c.dep.noDataFrames + c.dep.speechLostFrames + c.dep.sidFrames;
  const modeBonus = c.dep.mode === 'storage' ? 2 : 0; // if it was already storage, that’s usually the “correct” path
  return speech * 10 + Math.max(0, total - penalty) + modeBonus;
}

/* ---------------------------------- main ---------------------------------- */

export async function decodeTelnyxPayloadToPcm16(opts: DecodeTelnyxOptions): Promise<DecodeTelnyxResult | null> {
  const enc = normalizeTelnyxEncoding(opts.encoding);
  const encoding = enc.normalized;

  const state = opts.state ?? {};
  const hasState = opts.state !== undefined;
  const targetRate = opts.targetSampleRateHz;
  const channels = opts.channels ?? 1;

  // Log ingest codec info ONCE per call/session state.
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

  // PCMU
  if (encoding === 'PCMU') {
    const pcm = decodePcmu(opts.payload);
    const resampled = resamplePcm16(pcm, 8000, targetRate);
    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  // PCMA
  if (encoding === 'PCMA') {
    const pcm = decodePcma(opts.payload);
    const resampled = resamplePcm16(pcm, 8000, targetRate);
    await maybeDumpPostDecode(resampled, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(resampled, targetRate, encoding, state, opts.logContext);
    return { pcm16: resampled, sampleRateHz: targetRate, decodedFrames: 1 };
  }

  // AMR-WB
  if (encoding === 'AMR-WB') {
    if (!opts.allowAmrWb) return null;

    const candidates: AmrCandidate[] = [];

    // 1) Run transcoder FIRST so we know packing (be vs octet vs already-storage-ish).
    const transcode = transcodeTelnyxAmrWbPayload(opts.payload);

        // --- AMR-WB artifact capture (Step 2/3) ---
    if (parseBoolEnv(process.env.TRUTH_CAPTURE_AMRWB) || parseBoolEnv(process.env.AMRWB_ARTIFACT_DEBUG)) {
      // Always capture the raw payload so we can reproduce failures.
      writeAmrwbArtifacts('amrwb_raw_payload', opts.payload, {
        // raw RTP from Telnyx almost always includes CMR, but we don't "guess" for parsing;
        // this flag is only used when building .awb storage from an octet-aligned RTP payload.
        // For raw capture we mark as "hasCmr: true" to match Telnyx typical layout.
        hasCmr: true,
        meta: {
          encoding,
          payload_len: opts.payload.length,
          ...(opts.logContext ?? {}),
        },
      });

      // Capture transcoded output only if transcode succeeded.
      if (transcode.ok) {
        writeAmrwbArtifacts('amrwb_transcoded_output', transcode.output, {
          hasCmr: transcode.cmrStripped !== true, // if cmrStripped=true -> TOC starts at byte 0
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


    // If packing is BE, raw "octet" parsing is a trap: it may parse but will sound wrong.
    const forceTranscodedOnly = transcode.packing === 'be';

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
            ...(opts.logContext ?? {}),
          },
          `AMRWB_DEPACK invalid reason=${transcode.error} firstBytesHex=${hexPrefix} len=${opts.payload.length}`,
        );
      }

      state.amrwbLastError = 'amrwb_depack_invalid';
      // NOTE: we can still try raw as a fallback when transcode fails.
    } else {
      // Log depack once (or if you prefer, keep your existing gating)
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
            ...(opts.logContext ?? {}),
          },
          `AMRWB_DEPACK packing=${transcode.packing} rtpStripped=${transcode.rtpStripped} tocCount=${transcode.tocCount} totalBytesIn=${transcode.totalBytesIn} totalBytesOut=${transcode.totalBytesOut}`,
        );
      }

      const dep2 = depacketizeAmrWbToStorage(transcode.output, { skipCmr: Boolean(transcode.cmrStripped) });
      if (dep2.ok) {
        candidates.push({
          label: 'transcoded',
          dep: dep2,
          sourcePayloadLen: transcode.output.length,
          sourceHexPrefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
        });
      } else {
        if (!state.amrwbDepacketizeFailedLogged) {
          state.amrwbDepacketizeFailedLogged = true;
          log.warn(
            {
              event: 'amrwb_depacketize_failed',
              payload_len: transcode.output.length,
              cmr_stripped: transcode.cmrStripped ?? false,
              hex_prefix: transcode.output.subarray(0, Math.min(32, transcode.output.length)).toString('hex'),
              attempts: dep2.errors.map((error) => ({
                offset: error.offset,
                reason: error.reason,
                invalid_ft: error.invalidFt ?? null,
              })),
              ...(opts.logContext ?? {}),
            },
            'AMR-WB depacketize failed (post-transcode)',
          );
        }

        // If BE and transcoded failed, do NOT fall back to raw; raw will be garbage.
        if (transcode.packing === 'be') {
          state.amrwbLastError = 'amrwb_be_transcode_failed';
          return null;
        }
      }
    }

  
    // 2) Raw fallback is disabled by default.
    // Enable only if you are debugging a non-BE source.
    const allowRawFallback = parseBoolEnv(process.env.AMRWB_ALLOW_RAW_FALLBACK);
    if (!forceTranscodedOnly && allowRawFallback) {
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
      state.amrwbLastError = state.amrwbLastError ?? 'amrwb_no_candidates';
      return null;
    }

    // 3) Pick best candidate deterministically.
    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const chosen = candidates[0]!;
    const dep = chosen.dep;

    // Always log packing + chosen path at least once (this is the smoking gun when things regress).
    if (!state.amrwbDepacketizeLogged) {
      state.amrwbDepacketizeLogged = true;
      log.info(
        {
          event: 'amrwb_candidate_selected',
          packing: transcode.ok ? transcode.packing : 'transcode_failed',
          force_transcoded_only: forceTranscodedOnly,
          chosen: chosen.label,
          chosen_mode: dep.mode,
          chosen_frames: dep.totalFrames,
          chosen_speech_frames: dep.decodedFrames,
          chosen_len: chosen.sourcePayloadLen,
          chosen_hex_prefix: chosen.sourceHexPrefix,
          other: candidates.slice(1).map((c) => ({
            label: c.label,
            mode: c.dep.mode,
            frames: c.dep.totalFrames,
            speech_frames: c.dep.decodedFrames,
            len: c.sourcePayloadLen,
          })),
          ...(opts.logContext ?? {}),
        },
        'AMR-WB candidate selection',
      );
    }


    const samplesPerFrame = Math.max(1, Math.round(targetRate / AMRWB_FRAME_RATE));
    if (!dep.hasSpeechFrames) {
      state.amrwbLastError = undefined;
      const silentSamples = dep.totalFrames * samplesPerFrame;
      return {
        pcm16: silentSamples > 0 ? new Int16Array(silentSamples) : new Int16Array(0),
        sampleRateHz: targetRate,
        decodedFrames: dep.decodedFrames,
        decodeFailures: 0,
      };
    }

    let decoded: { pcm16: Int16Array } | null = null;
    let usedStream = false;
    const stream = hasState ? getAmrWbStream(state, targetRate) : null;

    if (stream) {
      try {
        const pcm16 = await stream.decode(dep.frames, dep.decodedFrames);
        if (pcm16.length > 0) {
          decoded = { pcm16 };
          usedStream = true;
          state.amrwbFfmpegUsable = true;
          state.amrwbLastError = undefined;
          if (!state.amrwbFfmpegStreamOkLogged) {
            state.amrwbFfmpegStreamOkLogged = true;
            const stats = computePcmStats(pcm16);
            log.info(
              {
                event: 'amrwb_ffmpeg_stream_ok',
                output_rate_hz: targetRate,
                samples: pcm16.length,
                rms: Number(stats.rms.toFixed(6)),
                peak: Number(stats.peak.toFixed(6)),
                mode: dep.mode,
                decoded_frames: dep.decodedFrames,
                decode_source: chosen.label,
                ffmpeg_path: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
                ...(opts.logContext ?? {}),
              },
              'AMR-WB ffmpeg stream decode ok',
            );
          }
        }
      } catch (error) {
        if (!state.amrwbFfmpegStreamFailedLogged) {
          state.amrwbFfmpegStreamFailedLogged = true;
          log.warn(
            {
              event: 'amrwb_ffmpeg_stream_failed',
              payload_len: chosen.sourcePayloadLen,
              mode: dep.mode,
              decoded_frames: dep.decodedFrames,
              stderr: stream.stderrSnippet(),
              err: error,
              decode_source: chosen.label,
              ffmpeg_path: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
              ...(opts.logContext ?? {}),
            },
            'AMR-WB ffmpeg stream decode failed',
          );
        }
        state.amrwbFfmpegStreamDisabled = true;
        state.amrwbFfmpegUsable = false;
        state.amrwbLastError = 'amrwb_ffmpeg_stream_failed';
        stream.close();
        state.amrwbFfmpegStream = undefined;
        state.amrwbFfmpegStreamRate = undefined;
      }
    }

    if (!decoded || decoded.pcm16.length === 0) {
      decoded = await decodeAmrWbWithFfmpeg(dep.storage, targetRate, opts.logContext);
      if (!decoded || decoded.pcm16.length === 0) {
        if (!state.amrwbFfmpegFailedLogged) {
          state.amrwbFfmpegFailedLogged = true;
          log.warn(
            {
              event: 'amrwb_ffmpeg_decode_failed',
              payload_len: chosen.sourcePayloadLen,
              storage_len: dep.storage.length,
              mode: dep.mode,
              decoded_frames: dep.decodedFrames,
              decode_source: chosen.label,
              ffmpeg_path: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
              ...(opts.logContext ?? {}),
            },
            'AMR-WB ffmpeg decode failed',
          );
        }
        state.amrwbFfmpegUsable = false;
        state.amrwbLastError = 'amrwb_ffmpeg_decode_failed';
        return null;
      }
    }

    const decodedRawSamples = decoded.pcm16.length;
    const expectedSpeechSamples = dep.decodedFrames * samplesPerFrame;

    if (amrwbStrictDecodeEnabled() && decodedRawSamples < expectedSpeechSamples) {
      const shortCount = (state.amrwbShortPcmCount ?? 0) + 1;
      state.amrwbShortPcmCount = shortCount;
      if (shortCount <= 10) {
        log.warn(
          {
            event: 'amrwb_decode_short_pcm',
            payload_len: opts.payload.length,
            decoded_raw_samples: decodedRawSamples,
            expected_speech_samples: expectedSpeechSamples,
            decoded_frames: dep.decodedFrames,
            total_frames: dep.totalFrames,
            mode: dep.mode,
            decode_source: chosen.label,
            ...(opts.logContext ?? {}),
          },
          'AMR-WB decoded PCM shorter than expected',
        );
      }
      state.amrwbLastError = 'amrwb_short_pcm';
      return null;
    }



    const actualSamples = decoded.pcm16.length;
    const zeroCount = countZeroSamples(decoded.pcm16);
    const zeroRatio = actualSamples > 0 ? zeroCount / actualSamples : 1;
    const decodedStats = computePcmStats(decoded.pcm16);
    const expectedTotalSamples = dep.totalFrames * samplesPerFrame;
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
          payload_len: opts.payload.length,
          decode_source: chosen.label,
          mode: dep.mode,
          decoded_frames: dep.decodedFrames,
          total_frames: dep.totalFrames,
          sid_frames: dep.sidFrames,
          no_data_frames: dep.noDataFrames,
          speech_lost_frames: dep.speechLostFrames,
          sample_rate_hz: targetRate,
          expected_speech_samples: expectedSpeechSamples,
          expected_total_samples: expectedTotalSamples,
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

    if (!usedStream && !state.amrwbFfmpegOkLogged) {
      state.amrwbFfmpegOkLogged = true;
      const stats = computePcmStats(decoded.pcm16);
      log.info(
        {
          event: 'amrwb_ffmpeg_decode_ok',
          output_rate_hz: targetRate,
          samples: decoded.pcm16.length,
          rms: Number(stats.rms.toFixed(6)),
          peak: Number(stats.peak.toFixed(6)),
          mode: dep.mode,
          decoded_frames: dep.decodedFrames,
          decode_source: chosen.label,
          ffmpeg_path: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
          ...(opts.logContext ?? {}),
        },
        'AMR-WB ffmpeg decode ok',
      );
    }

    await maybeDumpPostDecode(decoded.pcm16, targetRate, encoding, state, opts.logContext);
    await maybeDumpPcm16(decoded.pcm16, targetRate, encoding, state, opts.logContext);

    return {
      pcm16: decoded.pcm16,
      sampleRateHz: targetRate,
      decodedFrames: dep.decodedFrames,
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
