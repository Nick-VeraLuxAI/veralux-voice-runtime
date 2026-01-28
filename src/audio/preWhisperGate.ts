// src/audio/preWhisperGate.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Dedupe exact repeated PCM frames in a recent window.
 * This fixes "echo + slow" caused by upstream frame replay (lag-k).
 *
 * Frames are assumed to be ~20ms each:
 *   frameSamples = sampleRateHz / 50
 *
 * Returns: { samples, keptFrames, droppedFrames, frameSamples }
 */
function dedupeRecentPcmFrames(
  mono: Int16Array,
  sampleRateHz: number,
  windowSize: number,
): { samples: Int16Array; keptFrames: number; droppedFrames: number; frameSamples: number } {
  if (!Number.isFinite(windowSize) || windowSize <= 0) {
    return { samples: mono, keptFrames: 0, droppedFrames: 0, frameSamples: Math.max(1, Math.round(sampleRateHz / 50)) };
  }

  const frameSamples = Math.max(1, Math.round(sampleRateHz / 50));
  const totalFrames = Math.floor(mono.length / frameSamples);
  if (totalFrames <= 1) {
    return { samples: mono, keptFrames: totalFrames, droppedFrames: 0, frameSamples };
  }

  // Keep hashes for last N frames
  const recentQueue: string[] = [];
  const recentSet = new Set<string>();

  const kept: Int16Array[] = [];
  let keptFrames = 0;
  let droppedFrames = 0;

  for (let i = 0; i < totalFrames; i += 1) {
    const start = i * frameSamples;
    const end = start + frameSamples;

    // hash the raw bytes of this frame
    const frameView = mono.subarray(start, end);
    const frameBuf = Buffer.from(frameView.buffer, frameView.byteOffset, frameView.byteLength);

    const h = sha1Hex(frameBuf);

    // Drop if seen in recent window
    if (recentSet.has(h)) {
      droppedFrames += 1;
      continue;
    }

    kept.push(frameView);
    keptFrames += 1;

    // push into window
    recentQueue.push(h);
    recentSet.add(h);

    while (recentQueue.length > windowSize) {
      const old = recentQueue.shift();
      if (old) recentSet.delete(old);
    }
  }

  // append leftover tail samples (if any) — keep them as-is
  const tailStart = totalFrames * frameSamples;
  const tail = tailStart < mono.length ? mono.subarray(tailStart) : null;

  // concat kept frames (+ tail)
  const tailLen = tail ? tail.length : 0;
  const outLen = keptFrames * frameSamples + tailLen;
  const out = new Int16Array(outLen);

  let off = 0;
  for (const fr of kept) {
    out.set(fr, off);
    off += fr.length;
  }
  if (tail) out.set(tail, off);

  return { samples: out, keptFrames, droppedFrames, frameSamples };
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

  // -------------------- PCM RECENT-WINDOW DEDUPE (fix echo/slow) --------------------
  // Set STT_PREWHISPER_DEDUPE_WINDOW=0 to disable
  // Suggested starting points:
  //   16 or 32 (catches lag-k replay up to ~320–640ms)
  const dedupeWindow = Math.max(0, parseIntEnv('STT_PREWHISPER_DEDUPE_WINDOW', 0));
  const inRateForDedupe = inputSampleRate ?? OUTPUT_SAMPLE_RATE_HZ;

  const dd = dedupeRecentPcmFrames(mono, inRateForDedupe, dedupeWindow);
  if (dedupeWindow > 0 && dd.droppedFrames > 0) {
    mono = dd.samples;
  }

  // -------------------- RESAMPLE TO 16k --------------------
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

          // dedupe debug
          prewhisper_dedupe_window: dedupeWindow,
          prewhisper_dedupe_in_rate_hz: inRateForDedupe,
          prewhisper_dedupe_frame_samples: dd.frameSamples,
          prewhisper_dedupe_dropped_frames: dd.droppedFrames,
          prewhisper_dedupe_kept_frames: dd.keptFrames,
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

      prewhisper_dedupe_window: dedupeWindow,
      prewhisper_dedupe_in_rate_hz: inRateForDedupe,
      prewhisper_dedupe_frame_samples: dd.frameSamples,
      prewhisper_dedupe_dropped_frames: dd.droppedFrames,
      prewhisper_dedupe_kept_frames: dd.keptFrames,
    },
  };
}
