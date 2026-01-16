// src/audio/preWhisperGate.ts
import fs from 'fs';
import path from 'path';
import { decodeWavToPcm16, encodePcm16ToWav } from './postprocess';
import { resample48kTo16k } from './resample48kTo16k';
import { log } from '../log';

const OUTPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_CHANNELS = 1;

const DEFAULT_DUMP_LIMIT = 10;
const DEFAULT_DUMP_DIR = '/tmp/veralux-audio';

const dumpCounters = new Map<string, number>();
let dumpErrorLogged = false;

function preWhisperDumpLimit(): number {
  const raw = process.env.STT_PREWHISPER_DUMP_FIRST_N;
  if (!raw) return DEFAULT_DUMP_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DUMP_LIMIT;
  return Math.floor(parsed);
}

function preWhisperDumpDir(): string {
  const raw = process.env.STT_PREWHISPER_DUMP_DIR;
  return raw && raw.trim() !== '' ? raw.trim() : DEFAULT_DUMP_DIR;
}

function nextDumpSeq(callId: string): number | null {
  const limit = preWhisperDumpLimit();
  if (limit === 0) return null;
  const current = dumpCounters.get(callId) ?? 0;
  if (current >= limit) return null;
  const next = current + 1;
  dumpCounters.set(callId, next);
  return next;
}

function logDumpErrorOnce(error: unknown, note: string): void {
  if (dumpErrorLogged) return;
  dumpErrorLogged = true;
  log.warn({ event: 'stt_prewhisper_dump_failed', note, err: error }, 'prewhisper dump failed');
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

function downmixToMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const mixed = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    const base = i * channels;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += samples[base + ch] ?? 0;
    }
    mixed[i] = clampInt16(Math.round(sum / channels));
  }
  return mixed;
}

function bufferToInt16LE(buffer: Buffer): Int16Array {
  if (buffer.length % 2 !== 0) {
    throw new Error(`pcm16le_length_odd len=${buffer.length}`);
  }
  const sampleCount = buffer.length / 2;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function detectFormat(buf: Buffer): 'wav' | 'pcm' | 'unknown' {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav';
  }
  // raw PCM16LE should be even number of bytes
  if (buf.length > 0 && buf.length % 2 === 0) {
    return 'pcm';
  }
  return 'unknown';
}

function analyzePcm16(samples: Int16Array): { rms: number; peak: number; clipped: boolean } {
  if (samples.length === 0) return { rms: 0, peak: 0, clipped: false };
  let sumSquares = 0;
  let peak = 0;
  let clipped = false;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    if (s >= 32767 || s <= -32768) clipped = true;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    const f = s / 32768;
    sumSquares += f * f;
  }
  return { rms: Math.sqrt(sumSquares / samples.length), peak: peak / 32768, clipped };
}

/**
 * preWhisperGate expects input that is ALREADY DECODED to PCM/WAV by codecDecode.
 * It should NOT decode AMR-WB (that belongs earlier).
 */
export async function preWhisperGate(input: {
  buf: Buffer;
  hints?: { codec?: string; sampleRate?: number; channels?: number; callId?: string };

}): Promise<{ wav16kMono: Buffer; meta: Record<string, unknown> }> {
  const callId = input.hints?.callId ?? 'unknown';
  const format = detectFormat(input.buf);

  const dumpSeq = nextDumpSeq(callId);
  const dumpDir = preWhisperDumpDir();

  let beforePath: string | null = null;
  if (dumpSeq !== null) {
    const prefix = path.join(dumpDir, `prewhisper_${callId}_${String(dumpSeq).padStart(3, '0')}`);
    beforePath = `${prefix}_before.bin`;
    try {
      await fs.promises.mkdir(dumpDir, { recursive: true });
      await fs.promises.writeFile(beforePath, input.buf);
    } catch (error) {
      logDumpErrorOnce(error, 'before');
    }
  }

  let inputSampleRate = input.hints?.sampleRate;
  let inputChannels = input.hints?.channels ?? 1;

  let pcm16: Int16Array;

  if (format === 'wav') {
    const decoded = decodeWavToPcm16(input.buf);
    if (!decoded) {
      throw new Error(`wav_decode_failed len=${input.buf.length} callId=${callId}`);
    }
    pcm16 = decoded.samples;
    inputSampleRate = decoded.sampleRateHz;
    inputChannels = 1;
  } else if (format === 'pcm') {
    if (!inputSampleRate || inputSampleRate <= 0) {
      throw new Error(`pcm_missing_sample_rate len=${input.buf.length} callId=${callId}`);
    }
    if (!inputChannels || inputChannels <= 0) {
      throw new Error(`pcm_missing_channels len=${input.buf.length} callId=${callId}`);
    }
    pcm16 = bufferToInt16LE(input.buf);
  } else {
    throw new Error(`prewhisper_unknown_format len=${input.buf.length} callId=${callId}`);
  }

  let mono = downmixToMono(pcm16, inputChannels);

  if (inputSampleRate !== OUTPUT_SAMPLE_RATE_HZ) {
    if (inputSampleRate === 48000) {
      mono = resample48kTo16k(mono);
    } else {
      // linear resample (simple, but ok for a sanity gate)
      const inRate = inputSampleRate ?? OUTPUT_SAMPLE_RATE_HZ;
      const outLen = Math.max(1, Math.round(mono.length * (OUTPUT_SAMPLE_RATE_HZ / inRate)));
      const out = new Int16Array(outLen);
      const ratio = inRate / OUTPUT_SAMPLE_RATE_HZ;
      for (let i = 0; i < outLen; i += 1) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const next = Math.min(idx + 1, mono.length - 1);
        const frac = pos - idx;
        const s0 = mono[idx] ?? 0;
        const s1 = mono[next] ?? s0;
        out[i] = clampInt16(Math.round(s0 + (s1 - s0) * frac));
      }
      mono = out;
    }
  }

  const wav16kMono = encodePcm16ToWav(mono, OUTPUT_SAMPLE_RATE_HZ);
  const stats = analyzePcm16(mono);

  if (dumpSeq !== null) {
    const afterPath = path.join(dumpDir, `prewhisper_${callId}_${String(dumpSeq).padStart(3, '0')}_after.wav`);
    try {
      await fs.promises.writeFile(afterPath, wav16kMono);
      log.info(
        {
          event: 'stt_prewhisper_dump',
          call_id: callId,
          seq: dumpSeq,
          format,
          input_len: input.buf.length,
          output_wav_len: wav16kMono.length,
          rms: Number(stats.rms.toFixed(6)),
          peak: Number(stats.peak.toFixed(6)),
          clipped: stats.clipped,
          input_sample_rate_hz: inputSampleRate ?? null,
          input_channels: inputChannels ?? null,
          output_sample_rate_hz: OUTPUT_SAMPLE_RATE_HZ,
          output_channels: OUTPUT_CHANNELS,
          before_path: beforePath,
          after_path: afterPath,
        },
        'prewhisper dump',
      );
    } catch (error) {
      logDumpErrorOnce(error, 'after');
    }
  }

  return {
    wav16kMono,
    meta: {
      detected_format: format,
      input_sample_rate_hz: inputSampleRate ?? null,
      input_channels: inputChannels ?? null,
      output_sample_rate_hz: OUTPUT_SAMPLE_RATE_HZ,
      output_channels: OUTPUT_CHANNELS,
    },
  };
}
