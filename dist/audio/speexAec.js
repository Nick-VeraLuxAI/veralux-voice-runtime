"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAMPLE_RATE_HZ = exports.AEC_FILTER_LENGTH = exports.AEC_FRAME_SAMPLES = exports.speexAecAvailable = void 0;
exports.createSpeexAecState = createSpeexAecState;
exports.destroySpeexAecState = destroySpeexAecState;
exports.resetSpeexAecState = resetSpeexAecState;
exports.speexEchoCancel = speexEchoCancel;
const koffi_1 = __importDefault(require("koffi"));
const log_1 = require("../log");
const AEC_FRAME_SAMPLES = 320; // 20ms @ 16kHz
exports.AEC_FRAME_SAMPLES = AEC_FRAME_SAMPLES;
const AEC_FILTER_LENGTH = 2560; // 160ms tail @ 16kHz
exports.AEC_FILTER_LENGTH = AEC_FILTER_LENGTH;
const SAMPLE_RATE_HZ = 16000;
exports.SAMPLE_RATE_HZ = SAMPLE_RATE_HZ;
let lib = null;
let speexEchoStateInit;
let speexEchoStateDestroy;
let speexEchoCancellation;
let speexEchoStateReset;
function tryLoadSpeexDsp() {
    if (lib != null)
        return true;
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
            lib = koffi_1.default.load(name);
            speexEchoStateInit = lib.func('speex_echo_state_init', 'void*', ['int', 'int']);
            speexEchoStateDestroy = lib.func('speex_echo_state_destroy', 'void', ['void*']);
            speexEchoCancellation = lib.func('speex_echo_cancellation', 'void', ['void*', 'int16*', 'int16*', 'int16*']);
            speexEchoStateReset = lib.func('speex_echo_state_reset', 'void', ['void*']);
            log_1.log.info({ event: 'speex_aec_loaded', library: name }, 'SpeexDSP AEC loaded');
            return true;
        }
        catch (err) {
            // Try next name
            continue;
        }
    }
    log_1.log.warn({ event: 'speex_aec_load_failed', tried: names }, 'SpeexDSP not found; AEC disabled. Install: brew install speex (macOS) or apt install libspeexdsp-dev (Linux)');
    return false;
}
exports.speexAecAvailable = tryLoadSpeexDsp();
function createSpeexAecState() {
    if (!exports.speexAecAvailable || !lib)
        return null;
    try {
        const st = speexEchoStateInit(AEC_FRAME_SAMPLES, AEC_FILTER_LENGTH);
        if (!st)
            return null;
        return { st, frameSamples: AEC_FRAME_SAMPLES };
    }
    catch (err) {
        log_1.log.warn({ event: 'speex_aec_create_failed', err: String(err) }, 'Speex AEC state create failed');
        return null;
    }
}
function destroySpeexAecState(state) {
    if (state?.st && exports.speexAecAvailable) {
        try {
            speexEchoStateDestroy(state.st);
        }
        catch (err) {
            log_1.log.warn({ event: 'speex_aec_destroy_failed', err: String(err) }, 'Speex AEC state destroy failed');
        }
    }
}
function resetSpeexAecState(state) {
    if (state?.st && exports.speexAecAvailable) {
        try {
            speexEchoStateReset(state.st);
        }
        catch {
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
function speexEchoCancel(state, nearEnd, farEnd, output) {
    if (!exports.speexAecAvailable || !state?.st)
        return;
    const requiredBytes = AEC_FRAME_SAMPLES * 2;
    if (nearEnd.length < requiredBytes || farEnd.length < requiredBytes || output.length < requiredBytes) {
        return;
    }
    try {
        speexEchoCancellation(state.st, nearEnd, farEnd, output);
    }
    catch (err) {
        log_1.log.warn({ event: 'speex_aec_process_failed', err: String(err) }, 'Speex AEC process failed');
        nearEnd.copy(output, 0, 0, requiredBytes); // fallback: passthrough
    }
}
//# sourceMappingURL=speexAec.js.map