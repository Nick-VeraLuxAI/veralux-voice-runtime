// src/audio/farEndReference.ts
//
// Tier 3: Far-End Reference Tap
// For Telnyx "play by URL" we don't get streaming playback frames.
// This module generates a local far-end reference stream from TTS WAV:
// decode -> resample to 16k -> emit 20ms PCM16 frames into a per-call ring buffer.
// AEC (Tier 4) will consume these for echo cancellation.

import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { log } from '../log';
import { parseWavInfo } from './wavInfo';

const TARGET_SAMPLE_RATE_HZ = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (TARGET_SAMPLE_RATE_HZ * FRAME_MS) / 1000; // 320
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 640

/** Max frames to buffer per call (~15 seconds). Prevents unbounded growth. */
const MAX_FRAMES_PER_CALL = 750;

interface CallBuffer {
  frames: Buffer[];
  totalFrames: number;
}

const buffersByCall = new Map<string, CallBuffer>();

function clampInt16(n: number): number {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
}

/** Extract raw PCM16 mono from WAV. Returns { pcm, sampleRateHz }. */
function extractPcm16FromWav(wav: Buffer): { pcm: Int16Array; sampleRateHz: number } {
  const info = parseWavInfo(wav);
  if (info.bitsPerSample !== 16) {
    throw new Error(`far_end_ref: unsupported bits_per_sample=${info.bitsPerSample}`);
  }
  if (info.channels !== 1) {
    throw new Error(`far_end_ref: unsupported channels=${info.channels}`);
  }

  // Find data chunk
  let offset = 12;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataBytes = chunkSize;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    offset = chunkStart + paddedSize;
  }

  if (dataOffset === 0 || dataBytes === 0) {
    throw new Error('far_end_ref: missing data chunk');
  }

  const sampleCount = Math.floor(Math.min(dataBytes, wav.length - dataOffset) / 2);
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm[i] = wav.readInt16LE(dataOffset + i * 2);
  }

  return { pcm, sampleRateHz: info.sampleRateHz };
}

/** Resample PCM16 to 16kHz using linear interpolation. */
function resamplePcm16To16k(pcm: Int16Array, inputRateHz: number): Int16Array {
  if (inputRateHz <= 0 || pcm.length === 0) return new Int16Array(0);
  if (inputRateHz === TARGET_SAMPLE_RATE_HZ) return pcm;

  const ratio = inputRateHz / TARGET_SAMPLE_RATE_HZ;
  const outputLength = Math.max(1, Math.round(pcm.length / ratio));
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const nextIdx = Math.min(idx + 1, pcm.length - 1);
    const frac = srcPos - idx;
    const s0 = pcm[idx] ?? 0;
    const s1 = pcm[nextIdx] ?? s0;
    output[i] = clampInt16(Math.round(s0 + (s1 - s0) * frac));
  }
  return output;
}

/** Chunk PCM16 into 20ms frames (320 samples = 640 bytes each). */
function chunkIntoFrames(pcm: Int16Array): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + SAMPLES_PER_FRAME <= pcm.length) {
    const frame = Buffer.alloc(BYTES_PER_FRAME);
    for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
      frame.writeInt16LE(pcm[offset + i] ?? 0, i * 2);
    }
    frames.push(frame);
    offset += SAMPLES_PER_FRAME;
  }
  return frames;
}

/**
 * Push far-end reference frames from a TTS WAV.
 * Call this after synth/pipeline and before storeWav/playAudio.
 */
export function pushFarEndFrames(callControlId: string, wav: Buffer, logContext?: Record<string, unknown>): void {
  try {
    const { pcm, sampleRateHz } = extractPcm16FromWav(wav);
    const pcm16k = resamplePcm16To16k(pcm, sampleRateHz);
    const frames = chunkIntoFrames(pcm16k);

    if (frames.length === 0) return;

    let buf = buffersByCall.get(callControlId);
    if (!buf) {
      buf = { frames: [], totalFrames: 0 };
      buffersByCall.set(callControlId, buf);
    }

    for (const frame of frames) {
      if (buf.frames.length >= MAX_FRAMES_PER_CALL) {
        buf.frames.shift();
        buf.totalFrames -= 1;
      }
      buf.frames.push(frame);
      buf.totalFrames += 1;
    }

    log.debug(
      {
        event: 'far_end_ref_pushed',
        call_control_id: callControlId,
        frames_pushed: frames.length,
        total_frames: buf.totalFrames,
        input_sr: sampleRateHz,
        duration_ms: Math.round((frames.length * FRAME_MS)),
        ...(logContext ?? {}),
      },
      'far-end reference frames pushed',
    );
  } catch (err) {
    log.warn(
      {
        event: 'far_end_ref_push_failed',
        call_control_id: callControlId,
        err: err instanceof Error ? err.message : String(err),
        ...(logContext ?? {}),
      },
      'far-end reference push failed',
    );
  }
}

/**
 * Pull one far-end frame (20ms @ 16kHz) for AEC.
 * Returns null if no frames available.
 */
export function pullFarEndFrame(callControlId: string): Buffer | null {
  const buf = buffersByCall.get(callControlId);
  if (!buf || buf.frames.length === 0) return null;

  const frame = buf.frames.shift() ?? null;
  if (frame) buf.totalFrames -= 1;
  return frame;
}

/**
 * Release buffer for a call. Call on hangup.
 * If STT_DEBUG_DUMP_FAR_END_REF=true, dumps remaining frames to WAV before release.
 */
export function releaseFarEndBuffer(callControlId: string): void {
  const buf = buffersByCall.get(callControlId);
  if (buf && buf.frames.length > 0 && env.STT_DEBUG_DUMP_FAR_END_REF) {
    dumpFarEndToWav(callControlId, buf.frames);
  }
  const removed = buffersByCall.delete(callControlId);
  if (removed) {
    log.debug(
      { event: 'far_end_ref_released', call_control_id: callControlId },
      'far-end reference buffer released',
    );
  }
}

function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(TARGET_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(TARGET_SAMPLE_RATE_HZ * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

/** Debug: dump far-end frames to WAV for verification. */
function dumpFarEndToWav(callControlId: string, frames: Buffer[]): void {
  const dir = process.env.STT_DEBUG_DIR?.trim() || '/tmp/veralux-stt-debug';
  const safe = callControlId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const pcm = Buffer.concat(frames);
  const header = wavHeader(pcm.length);
  const outPath = path.join(dir, `far_end_ref_${safe}_${Date.now()}.wav`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
    log.info(
      {
        event: 'far_end_ref_wav_dumped',
        call_control_id: callControlId,
        path: outPath,
        frames: frames.length,
        duration_ms: frames.length * FRAME_MS,
      },
      'far-end reference WAV dumped',
    );
  } catch (err) {
    log.warn(
      { event: 'far_end_ref_dump_failed', call_control_id: callControlId, err: String(err) },
      'far-end reference dump failed',
    );
  }
}

/**
 * Get current frame count for a call (for debugging/dumps).
 */
export function getFarEndFrameCount(callControlId: string): number {
  return buffersByCall.get(callControlId)?.totalFrames ?? 0;
}
