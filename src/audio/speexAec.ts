// src/audio/speexAec.ts
//
// Tier 4: SpeexDSP Acoustic Echo Cancellation
// Uses FFI (koffi) to load libspeexdsp and run echo cancellation on near-end (mic)
// against far-end (playback) reference frames.
//
// Requires: libspeexdsp installed on system
//   macOS: brew install speex
//   Linux: apt install libspeexdsp-dev
//
// If the library cannot be loaded, AEC is disabled (passthrough).

import koffi from 'koffi';
import { log } from '../log';

const AEC_FRAME_SAMPLES = 320; // 20ms @ 16kHz
const AEC_FILTER_LENGTH = 2560; // 160ms tail @ 16kHz
const SAMPLE_RATE_HZ = 16000;

let lib: ReturnType<typeof koffi.load> | null = null;
let speexEchoStateInit: (frameSize: number, filterLength: number) => unknown;
let speexEchoStateDestroy: (st: unknown) => void;
let speexEchoCancellation: (
  st: unknown,
  rec: Buffer,
  play: Buffer,
  out: Buffer,
) => void;
let speexEchoStateReset: (st: unknown) => void;

function tryLoadSpeexDsp(): boolean {
  if (lib != null) return true;

  // Try simple names first (works when lib is in LD_LIBRARY_PATH / DYLD_LIBRARY_PATH)
  const names = [
    'speexdsp',
    'libspeexdsp',
    'libspeexdsp.0',
    ...(process.platform === 'darwin'
      ? ['/opt/homebrew/lib/libspeexdsp.dylib', '/usr/local/lib/libspeexdsp.dylib']
      : []),
    ...(process.platform === 'linux' ? ['/usr/lib/x86_64-linux-gnu/libspeexdsp.so', '/usr/lib/libspeexdsp.so'] : []),
  ];
  for (const name of names) {
    try {
      lib = koffi.load(name);
      speexEchoStateInit = lib.func(
        'speex_echo_state_init',
        'void*',
        ['int', 'int'],
      );
      speexEchoStateDestroy = lib.func(
        'speex_echo_state_destroy',
        'void',
        ['void*'],
      );
      speexEchoCancellation = lib.func(
        'speex_echo_cancellation',
        'void',
        ['void*', 'int16*', 'int16*', 'int16*'],
      );
      speexEchoStateReset = lib.func(
        'speex_echo_state_reset',
        'void',
        ['void*'],
      );
      log.info({ event: 'speex_aec_loaded', library: name }, 'SpeexDSP AEC loaded');
      return true;
    } catch (err) {
      // Try next name
      continue;
    }
  }

  log.warn(
    { event: 'speex_aec_load_failed', tried: names },
    'SpeexDSP not found; AEC disabled. Install: brew install speex (macOS) or apt install libspeexdsp-dev (Linux)',
  );
  return false;
}

export const speexAecAvailable = tryLoadSpeexDsp();

export interface SpeexAecState {
  st: unknown;
  frameSamples: number;
}

export function createSpeexAecState(): SpeexAecState | null {
  if (!speexAecAvailable || !lib) return null;

  try {
    const st = speexEchoStateInit(AEC_FRAME_SAMPLES, AEC_FILTER_LENGTH);
    if (!st) return null;
    return { st, frameSamples: AEC_FRAME_SAMPLES };
  } catch (err) {
    log.warn({ event: 'speex_aec_create_failed', err: String(err) }, 'Speex AEC state create failed');
    return null;
  }
}

export function destroySpeexAecState(state: SpeexAecState): void {
  if (state?.st && speexAecAvailable) {
    try {
      speexEchoStateDestroy(state.st);
    } catch (err) {
      log.warn({ event: 'speex_aec_destroy_failed', err: String(err) }, 'Speex AEC state destroy failed');
    }
  }
}

export function resetSpeexAecState(state: SpeexAecState): void {
  if (state?.st && speexAecAvailable) {
    try {
      speexEchoStateReset(state.st);
    } catch {
      // ignore
    }
  }
}

/**
 * Run echo cancellation on one 20ms frame.
 * @param state AEC state
 * @param nearEnd 320 int16 samples (20ms @ 16kHz) - mic input
 * @param farEnd 320 int16 samples (20ms @ 16kHz) - playback reference
 * @param output Buffer to write 320 int16 samples (cleaned near-end)
 */
export function speexEchoCancel(
  state: SpeexAecState,
  nearEnd: Buffer,
  farEnd: Buffer,
  output: Buffer,
): void {
  if (!speexAecAvailable || !state?.st) return;

  const requiredBytes = AEC_FRAME_SAMPLES * 2;
  if (nearEnd.length < requiredBytes || farEnd.length < requiredBytes || output.length < requiredBytes) {
    return;
  }

  try {
    speexEchoCancellation(state.st, nearEnd, farEnd, output);
  } catch (err) {
    log.warn({ event: 'speex_aec_process_failed', err: String(err) }, 'Speex AEC process failed');
    nearEnd.copy(output, 0, 0, requiredBytes); // fallback: passthrough
  }
}

export { AEC_FRAME_SAMPLES, AEC_FILTER_LENGTH, SAMPLE_RATE_HZ };
