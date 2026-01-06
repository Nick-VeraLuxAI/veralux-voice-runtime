import fs from 'fs';
import path from 'path';
import { log } from '../log';
import { AmrWbDecoder } from './vendor/amrwb/AmrWbDecoder';
import { G722Decoder } from './vendor/g722/g722';
import OpusDecoder from './vendor/opus/OpusDecoder';
import { encodePcm16ToWav } from './postprocess';

export interface TelnyxCodecState {
  amrwb?: AmrWbDecoder;
  amrwbReady?: Promise<void>;
  amrwbFailed?: boolean;
  amrwbLastError?: string;
  g722?: G722Decoder;
  opus?: any;
  opusReady?: Promise<void>;
  opusFailed?: boolean;
  debugLastPostDecodeMs?: number;
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

export function parseTelnyxAcceptCodecs(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) {
    return set;
  }
  for (const part of raw.split(',')) {
    const normalized = part.trim().toUpperCase();
    if (normalized) {
      set.add(normalized === 'AMRWB' || normalized === 'AMR_WB' ? 'AMR-WB' : normalized);
    }
  }
  return set;
}

export function shouldUsePcm16Ingest(
  acceptCodecs: Set<string>,
  allowAmrWb: boolean,
  allowG722: boolean,
  allowOpus: boolean,
): boolean {
  for (const codec of acceptCodecs) {
    if (codec !== 'PCMU') {
      return true;
    }
  }
  return allowAmrWb || allowG722 || allowOpus;
}

const DEFAULT_OPUS_SAMPLE_RATE = 48000;
const DEBUG_POST_DECODE_INTERVAL_MS = 1000;

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

async function maybeDumpPostDecode(
  samples: Int16Array,
  sampleRateHz: number,
  encoding: string,
  state: TelnyxCodecState | undefined,
  logContext: Record<string, unknown> | undefined,
): Promise<void> {
  if (!debugPostDecodeEnabled()) return;
  const now = Date.now();
  if (state?.debugLastPostDecodeMs && now - state.debugLastPostDecodeMs < DEBUG_POST_DECODE_INTERVAL_MS) {
    return;
  }
  if (state) state.debugLastPostDecodeMs = now;

  const callId = typeof logContext?.call_control_id === 'string' ? logContext.call_control_id : 'unknown';
  const dir = debugDir();
  const filePath = path.join(dir, `post_decode_${callId}_${now}.wav`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const wav = encodePcm16ToWav(samples, sampleRateHz);
    await fs.promises.writeFile(filePath, wav);
  } catch (error) {
    log.warn(
      { event: 'stt_post_decode_dump_failed', encoding, file_path: filePath, err: error, ...(logContext ?? {}) },
      'stt post-decode dump failed',
    );
    return;
  }

  const stats = computePcmStats(samples);
  log.info(
    {
      event: 'stt_post_decode',
      encoding,
      sample_rate_hz: sampleRateHz,
      samples: samples.length,
      rms: Number(stats.rms.toFixed(6)),
      peak: Number(stats.peak.toFixed(6)),
      file_path: filePath,
      ...(logContext ?? {}),
    },
    'stt post-decode dump',
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
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = muLawToPcmSample(payload[i]);
  }
  return out;
}

function decodePcma(payload: Buffer): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = aLawToPcmSample(payload[i]);
  }
  return out;
}

function downmixInterleaved(pcm: Int16Array, channels: number): Int16Array {
  if (channels <= 1) {
    return pcm;
  }
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    const base = i * channels;
    for (let c = 0; c < channels; c += 1) {
      sum += pcm[base + c] ?? 0;
    }
    out[i] = clampInt16(Math.round(sum / channels));
  }
  return out;
}

function downmixFloat32(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array();
  }
  if (channels.length === 1) {
    return channels[0];
  }
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i] ?? 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clampInt16(Math.round(s * 32767));
  }
  return out;
}

function isFloat32ArrayArray(value: unknown): value is Float32Array[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((entry) => entry instanceof Float32Array);
}

export function resamplePcm16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate <= 0 || outputRate <= 0 || input.length === 0) {
    return input;
  }
  if (inputRate === outputRate) {
    return input;
  }

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
  if (payload.length < 4) {
    return false;
  }
  return payload.toString('ascii', 0, 4) === 'OggS';
}

const AMRWB_FRAME_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60];
const AMRWB_SID_FRAME_BYTES = 5;

function isAmrWbSingleFrame(payloadLength: number): boolean {
  return AMRWB_FRAME_SIZES.includes(payloadLength);
}

function splitAmrWbSingleFrameWithHeader(payload: Buffer): Buffer[] | null {
  if (isAmrWbSingleFrame(payload.length)) {
    return [payload];
  }
  if (payload.length > 1 && isAmrWbSingleFrame(payload.length - 1)) {
    return [payload.subarray(1)];
  }
  if (payload.length > 2 && isAmrWbSingleFrame(payload.length - 2)) {
    return [payload.subarray(2)];
  }
  return null;
}

function amrWbFrameSize(ft: number): number {
  if (ft >= 0 && ft < AMRWB_FRAME_SIZES.length) {
    return AMRWB_FRAME_SIZES[ft] ?? 0;
  }
  if (ft === 9) {
    return AMRWB_SID_FRAME_BYTES;
  }
  return 0;
}

function parseAmrWbOctetAligned(payload: Buffer, startOffset: number): Buffer[] | null {
  if (payload.length === 0) {
    return null;
  }
  if (startOffset >= payload.length) {
    return null;
  }

  let offset = startOffset;
  const tocEntries: Array<{ ft: number }> = [];
  let follow = true;

  while (follow && offset < payload.length) {
    const toc = payload[offset++];
    follow = (toc & 0x80) !== 0;
    const ft = (toc >> 3) & 0x0f;
    tocEntries.push({ ft });
  }

  const frames: Buffer[] = [];
  for (const entry of tocEntries) {
    const size = amrWbFrameSize(entry.ft);
    if (size === AMRWB_SID_FRAME_BYTES) {
      if (offset + size > payload.length) {
        return null;
      }
      offset += size;
      continue;
    }
    if (size <= 0) {
      return null;
    }
    if (offset + size > payload.length) {
      return null;
    }
    frames.push(payload.subarray(offset, offset + size));
    offset += size;
  }

  return frames.length ? frames : null;
}

function splitAmrWbPayload(payload: Buffer): Buffer[] | null {
  if (payload.length === 0) {
    return null;
  }
  if (payload.length === AMRWB_SID_FRAME_BYTES) {
    return [];
  }
  const singleFrame = splitAmrWbSingleFrameWithHeader(payload);
  if (singleFrame) {
    return singleFrame;
  }
  if (payload.length < 2) {
    return null;
  }

  // Try octet-aligned with CMR (skip 1 byte), then without CMR.
  const withCmr = parseAmrWbOctetAligned(payload, 1);
  if (withCmr) {
    return withCmr;
  }
  return parseAmrWbOctetAligned(payload, 0);
}

export async function decodeTelnyxPayloadToPcm16(
  opts: DecodeTelnyxOptions,
): Promise<{ pcm16: Int16Array; sampleRateHz: number } | null> {
  const encoding = opts.encoding.trim().toUpperCase();
  const channels = opts.channels ?? 1;
  const targetRate = opts.targetSampleRateHz;

  if (encoding === 'PCMU') {
    const pcm = decodePcmu(opts.payload);
    const mono = downmixInterleaved(pcm, channels);
    const resampled = resamplePcm16(mono, 8000, targetRate);
    return { pcm16: resampled, sampleRateHz: targetRate };
  }

  if (encoding === 'PCMA') {
    const pcm = decodePcma(opts.payload);
    const mono = downmixInterleaved(pcm, channels);
    const resampled = resamplePcm16(mono, 8000, targetRate);
    return { pcm16: resampled, sampleRateHz: targetRate };
  }

  if (encoding === 'AMR-WB') {
    if (!opts.allowAmrWb) {
      return null;
    }
    const state = opts.state ?? {};
    if (!state.amrwb && !state.amrwbFailed) {
      state.amrwb = new AmrWbDecoder();
      state.amrwbReady = state.amrwb.init();
    }
    if (!state.amrwb || state.amrwbFailed) {
      return null;
    }
    if (state.amrwbReady) {
      try {
        await state.amrwbReady;
      } catch (error) {
        state.amrwbFailed = true;
        state.amrwbLastError = error instanceof Error ? error.message : 'amrwb_init_failed';
        return null;
      }
    }
    try {
      const frames = splitAmrWbPayload(opts.payload);
      const framesToDecode = frames ?? [opts.payload];
      if (frames && frames.length === 1 && frames[0].length !== opts.payload.length) {
        if (state.amrwbLastError !== 'amrwb_header_stripped') {
          state.amrwbLastError = 'amrwb_header_stripped';
          log.info(
            {
              event: 'amrwb_header_stripped',
              payload_len: opts.payload.length,
              frame_len: frames[0].length,
              ...(opts.logContext ?? {}),
            },
            'amr-wb header stripped before decode',
          );
        }
      }
      if (!frames && state.amrwbLastError !== 'amrwb_packet_parse_failed') {
        state.amrwbLastError = 'amrwb_packet_parse_failed';
        log.warn(
          {
            event: 'amrwb_packet_parse_failed',
            length: opts.payload.length,
            ...(opts.logContext ?? {}),
          },
          'amr-wb payload could not be split into frames; decoding raw payload',
        );
      }

      const chunks: Int16Array[] = [];
      let totalSamples = 0;
      for (const frame of framesToDecode) {
        if (frame.length === AMRWB_SID_FRAME_BYTES) {
          continue;
        }
        const decoded = state.amrwb.decodeFrame(new Uint8Array(frame));
        chunks.push(decoded);
        totalSamples += decoded.length;
      }
      if (totalSamples === 0) {
        return { pcm16: new Int16Array(0), sampleRateHz: targetRate };
      }

      const merged = new Int16Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      const resampled = resamplePcm16(merged, 16000, targetRate);
      return { pcm16: resampled, sampleRateHz: targetRate };
    } catch (error) {
      state.amrwbLastError = error instanceof Error ? error.message : 'amrwb_decode_failed';
      return null;
    }
  }

  if (encoding === 'G722') {
    if (!opts.allowG722) {
      return null;
    }
    const state = opts.state ?? {};
    if (!state.g722) {
      state.g722 = new G722Decoder(64000, 0);
    }
    const decoded = state.g722.decode(opts.payload);
    const mono = downmixInterleaved(decoded, channels);
    const resampled = resamplePcm16(mono, 16000, targetRate);
    return { pcm16: resampled, sampleRateHz: targetRate };
  }

  if (encoding === 'OPUS') {
    if (!opts.allowOpus) {
      return null;
    }
    if (looksLikeOgg(opts.payload)) {
      log.warn(
        {
          event: 'opus_container_detected',
          encoding,
          length: opts.payload.length,
          ...(opts.logContext ?? {}),
        },
        'Opus payload appears to be Ogg; expected raw Opus packets',
      );
      return null;
    }

    const state = opts.state ?? {};
    if (!state.opus && !state.opusFailed) {
      try {
        state.opus = new OpusDecoder();
        state.opusReady = state.opus.ready;
      } catch (error) {
        state.opusFailed = true;
        log.warn(
          { err: error, event: 'opus_decoder_init_failed', ...(opts.logContext ?? {}) },
          'Opus decoder init failed',
        );
        return null;
      }
    }

    if (!state.opus || state.opusFailed) {
      return null;
    }

    if (state.opusReady) {
      try {
        await state.opusReady;
      } catch (error) {
        state.opusFailed = true;
        log.warn(
          { err: error, event: 'opus_decoder_ready_failed', ...(opts.logContext ?? {}) },
          'Opus decoder ready failed',
        );
        return null;
      }
    }

    const result = state.opus.decodeFrame(new Uint8Array(opts.payload));
    if (!result || !isFloat32ArrayArray(result.channelData)) {
      return null;
    }
    const monoFloat = downmixFloat32(result.channelData);
    const pcm = floatToPcm16(monoFloat);
    const inputRate = typeof result.sampleRate === 'number' ? result.sampleRate : DEFAULT_OPUS_SAMPLE_RATE;
    const resampled = resamplePcm16(pcm, inputRate, targetRate);
    return { pcm16: resampled, sampleRateHz: targetRate };
  }

  return null;
}
