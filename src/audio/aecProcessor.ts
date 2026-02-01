// src/audio/aecProcessor.ts
//
// Tier 4: AEC Processor
// Buffers inbound PCM to 20ms frames, pulls far-end reference, runs Speex AEC,
// and emits cleaned frames. When AEC is unavailable or no far-end, passthrough.

import { log } from '../log';
import { pullFarEndFrame } from './farEndReference';
import {
  speexAecAvailable,
  createSpeexAecState,
  destroySpeexAecState,
  resetSpeexAecState,
  speexEchoCancel,
  AEC_FRAME_SAMPLES,
} from './speexAec';

const BYTES_PER_FRAME = AEC_FRAME_SAMPLES * 2; // 640

interface CallState {
  aecState: ReturnType<typeof createSpeexAecState>;
  buffer: Buffer;
  bufferSamples: number;
}

const stateByCall = new Map<string, CallState>();

function getOrCreateState(callControlId: string): CallState {
  let st = stateByCall.get(callControlId);
  if (!st) {
    st = {
      aecState: createSpeexAecState(),
      buffer: Buffer.alloc(0),
      bufferSamples: 0,
    };
    stateByCall.set(callControlId, st);
  }
  return st;
}

export function releaseAecProcessor(callControlId: string): void {
  const st = stateByCall.get(callControlId);
  if (st) {
    if (st.aecState) destroySpeexAecState(st.aecState);
    stateByCall.delete(callControlId);
  }
}

export function resetAecProcessor(callControlId: string): void {
  const st = stateByCall.get(callControlId);
  if (st?.aecState) {
    resetSpeexAecState(st.aecState);
  }
  // Clear buffer on playback transition
  if (st) {
    st.buffer = Buffer.alloc(0);
    st.bufferSamples = 0;
  }
}

export type AecFrameCallback = (pcm16: Int16Array, sampleRateHz: number) => void;

/**
 * Process inbound PCM through AEC (when available) and emit cleaned frames.
 * Callback is invoked for each 20ms frame.
 */
export function processAec(
  callControlId: string,
  pcm16: Int16Array,
  sampleRateHz: number,
  onFrame: AecFrameCallback,
  logContext?: Record<string, unknown>,
): void {
  if (sampleRateHz !== 16000) {
    onFrame(pcm16, sampleRateHz);
    return;
  }

  const st = getOrCreateState(callControlId);

  // Append to buffer
  const newBytes = pcm16.length * 2;
  st.buffer = Buffer.concat([st.buffer, Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)]);
  st.bufferSamples += pcm16.length;

  // Process complete 20ms frames
  while (st.bufferSamples >= AEC_FRAME_SAMPLES) {
    const nearFrame = st.buffer.subarray(0, BYTES_PER_FRAME);
    const farFrame = pullFarEndFrame(callControlId);

    let output: Buffer;

    if (speexAecAvailable && st.aecState && farFrame && farFrame.length >= BYTES_PER_FRAME) {
      output = Buffer.alloc(BYTES_PER_FRAME);
      speexEchoCancel(st.aecState, nearFrame, farFrame, output);
    } else {
      output = nearFrame;
    }

    const outSamples = new Int16Array(AEC_FRAME_SAMPLES);
    outSamples.set(new Int16Array(output.buffer, output.byteOffset, AEC_FRAME_SAMPLES));
    onFrame(outSamples, sampleRateHz);

    st.buffer = st.buffer.subarray(BYTES_PER_FRAME);
    st.bufferSamples -= AEC_FRAME_SAMPLES;
  }
}

/** Flush any remaining buffered samples (passthrough). */
export function flushAecProcessor(
  callControlId: string,
  onFrame: AecFrameCallback,
  sampleRateHz: number,
): void {
  const st = stateByCall.get(callControlId);
  if (!st || st.bufferSamples === 0) return;

  const samples = Math.floor(st.buffer.length / 2);
  if (samples > 0) {
    const pcm16 = new Int16Array(st.buffer.buffer, st.buffer.byteOffset, samples);
    onFrame(pcm16, sampleRateHz);
  }
  st.buffer = Buffer.alloc(0);
  st.bufferSamples = 0;
}

export { speexAecAvailable };
