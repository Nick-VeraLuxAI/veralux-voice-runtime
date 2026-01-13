import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { decodeWavToPcm16, encodePcm16ToWav } from './postprocess';
import { resample48kTo16k } from './resample48kTo16k';
import { log } from '../log';

const OUTPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_CHANNELS = 1;
const DEFAULT_DUMP_LIMIT = 10;
const DEFAULT_DUMP_DIR = '/tmp/veralux-audio';
const AMRWB_HEADER = '#!AMR-WB\n';

const dumpCounters = new Map<string, number>();
const gateErrorLogged = new Set<string>();
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

function getHexPrefix(buf: Buffer, len = 16): string {
  return buf.subarray(0, len).toString('hex');
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

function logGateErrorOnce(callId: string, detected: string, input: Buffer, error: unknown): void {
  if (gateErrorLogged.has(callId)) return;
  gateErrorLogged.add(callId);
  log.warn(
    {
      event: 'stt_prewhisper_gate_error',
      call_id: callId,
      format: detected,
      input_len: input.length,
      hex_prefix: getHexPrefix(input, 16),
      err: error,
    },
    'prewhisper gate error',
  );
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

function resampleLinear(samples: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (samples.length === 0) return samples;
  if (inputRate <= 0 || outputRate <= 0) return samples;
  if (inputRate === outputRate) return samples;

  const outputLength = Math.max(1, Math.round(samples.length * (outputRate / inputRate)));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const nextIndex = Math.min(index + 1, samples.length - 1);
    const frac = position - index;
    const s0 = samples[index] ?? 0;
    const s1 = samples[nextIndex] ?? s0;
    output[i] = clampInt16(Math.round(s0 + (s1 - s0) * frac));
  }
  return output;
}

function analyzePcm16(samples: Int16Array): {
  rms: number;
  peak: number;
  clipped: boolean;
  dcOffsetApprox: number;
} {
  if (samples.length === 0) {
    return { rms: 0, peak: 0, clipped: false, dcOffsetApprox: 0 };
  }
  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipped = false;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    if (s >= 32767 || s <= -32768) clipped = true;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSquares += (s / 32768) * (s / 32768);
    sum += s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const dcOffsetApprox = sum / samples.length / 32768;
  return { rms, peak: peak / 32768, clipped, dcOffsetApprox };
}

function decodeMuLawToPcm16(muLaw: Buffer): Int16Array {
  const samples = new Int16Array(muLaw.length);
  for (let i = 0; i < muLaw.length; i += 1) {
    const u = (~muLaw[i]) & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const bias = 0x84;
    let sample = ((mantissa << 3) + bias) << exponent;
    sample -= bias;
    if (sign) sample = -sample;
    samples[i] = clampInt16(sample);
  }
  return samples;
}

async function decodeAmrWbToPcm16(input: Buffer, callId: string): Promise<Int16Array> {
  if (!input.subarray(0, AMRWB_HEADER.length).equals(Buffer.from(AMRWB_HEADER, 'ascii'))) {
    throw new Error(`amrwb_header_missing len=${input.length} hex=${getHexPrefix(input, 16)} callId=${callId}`);
  }

  return new Promise<Int16Array>((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'amrwb', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'];
    const ffmpeg = spawn('ffmpeg', args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      ffmpeg.kill('SIGKILL');
    }, 5000);

    ffmpeg.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    ffmpeg.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    ffmpeg.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`amrwb_decode_timeout len=${input.length} callId=${callId}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `amrwb_decode_failed code=${code} stderr=${Buffer.concat(stderr).toString('utf8')} len=${input.length} callId=${callId}`,
          ),
        );
        return;
      }
      const out = Buffer.concat(stdout);
      if (out.length === 0) {
        reject(new Error(`amrwb_decode_empty len=${input.length} callId=${callId}`));
        return;
      }
      try {
        resolve(bufferToInt16LE(out));
      } catch (error) {
        reject(error);
      }
    });

    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}

export function detectFormat(buf: Buffer): 'wav' | 'amrwb' | 'pcm' | 'unknown' {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (buf.length >= AMRWB_HEADER.length && buf.subarray(0, AMRWB_HEADER.length).toString('ascii') === AMRWB_HEADER) {
    return 'amrwb';
  }
  if (buf.length > 0 && buf.length % 2 === 0) {
    return 'pcm';
  }
  return 'unknown';
}

/**
 * HOW TO RUN:
 *   STT_PREWHISPER_GATE=true STT_PREWHISPER_DUMP_FIRST_N=10 STT_PREWHISPER_DUMP_DIR=/tmp/veralux-audio npm run dev
 *   Listen to the dumped *_after.wav outputs; they should be clean 16k mono PCM16 WAVs.
 */
export async function preWhisperGate(input: {
  buf: Buffer;
  hints?: { codec?: string; sampleRate?: number; channels?: number; callId?: string };
}): Promise<{ wav16kMono: Buffer; meta: Record<string, unknown> }> {
  const callId = input.hints?.callId ?? 'unknown';
  const format = detectFormat(input.buf);
  let detected = format;
  const hintedCodec = input.hints?.codec?.trim().toLowerCase();
  if (detected === 'unknown' && (hintedCodec === 'pcmu' || hintedCodec === 'pcm16le')) {
    detected = 'pcm';
  }
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
  try {
    if (detected === 'wav') {
      const decoded = decodeWavToPcm16(input.buf);
      if (!decoded) {
        throw new Error(
          `wav_decode_failed len=${input.buf.length} hex=${getHexPrefix(input.buf, 16)} callId=${callId}`,
        );
      }
      pcm16 = decoded.samples;
      inputSampleRate = decoded.sampleRateHz;
      inputChannels = 1;
    } else if (detected === 'amrwb') {
      pcm16 = await decodeAmrWbToPcm16(input.buf, callId);
      inputSampleRate = OUTPUT_SAMPLE_RATE_HZ;
      inputChannels = 1;
    } else if (detected === 'pcm') {
      if (!inputSampleRate || inputSampleRate <= 0) {
        throw new Error(
          `pcm_missing_sample_rate len=${input.buf.length} hex=${getHexPrefix(input.buf, 16)} callId=${callId}`,
        );
      }
      if (!inputChannels || inputChannels <= 0) {
        throw new Error(
          `pcm_missing_channels len=${input.buf.length} hex=${getHexPrefix(input.buf, 16)} callId=${callId}`,
        );
      }
      if (input.hints?.codec === 'pcmu') {
        pcm16 = decodeMuLawToPcm16(input.buf);
      } else {
        pcm16 = bufferToInt16LE(input.buf);
      }
    } else {
      detected = 'unknown';
      throw new Error(
        `format_unknown len=${input.buf.length} hex=${getHexPrefix(input.buf, 16)} callId=${callId}`,
      );
    }
  } catch (error) {
    logGateErrorOnce(callId, detected, input.buf, error);
    if (dumpSeq !== null) {
      log.info(
        {
          event: 'stt_prewhisper_dump',
          call_id: callId,
          seq: dumpSeq,
          format: detected,
          input_len: input.buf.length,
          error: error instanceof Error ? error.message : String(error),
          before_path: beforePath,
        },
        `prewhisper_dump callId=${callId} seq=${dumpSeq} format=${detected} input_len=${input.buf.length} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }

  let mono = downmixToMono(pcm16, inputChannels);
  if (inputSampleRate !== OUTPUT_SAMPLE_RATE_HZ) {
    if (inputSampleRate === 48000) {
      mono = resample48kTo16k(mono);
    } else {
      mono = resampleLinear(mono, inputSampleRate ?? OUTPUT_SAMPLE_RATE_HZ, OUTPUT_SAMPLE_RATE_HZ);
    }
  }

  const wav16kMono = encodePcm16ToWav(mono, OUTPUT_SAMPLE_RATE_HZ);
  const stats = analyzePcm16(mono);

  if (dumpSeq !== null) {
    const afterPath = path.join(
      dumpDir,
      `prewhisper_${callId}_${String(dumpSeq).padStart(3, '0')}_after.wav`,
    );
    try {
      await fs.promises.writeFile(afterPath, wav16kMono);
      log.info(
        {
          event: 'stt_prewhisper_dump',
          call_id: callId,
          seq: dumpSeq,
          format: detected,
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
        `prewhisper_dump callId=${callId} seq=${dumpSeq} format=${detected} input_len=${input.buf.length} output_wav_len=${wav16kMono.length} rms=${stats.rms.toFixed(
          6,
        )} peak=${stats.peak.toFixed(6)} clipped=${stats.clipped} in_rate=${inputSampleRate ?? 'n/a'} in_ch=${
          inputChannels ?? 'n/a'
        } out_rate=${OUTPUT_SAMPLE_RATE_HZ} out_ch=${OUTPUT_CHANNELS}`,
      );
    } catch (error) {
      logDumpErrorOnce(error, 'after');
    }
  }

  return {
    wav16kMono,
    meta: {
      detected_format: detected,
      input_sample_rate_hz: inputSampleRate ?? null,
      input_channels: inputChannels ?? null,
      output_sample_rate_hz: OUTPUT_SAMPLE_RATE_HZ,
      output_channels: OUTPUT_CHANNELS,
      input_codec: input.hints?.codec ?? null,
    },
  };
}

export { analyzePcm16 };
