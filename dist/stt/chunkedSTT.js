"use strict";
// src/stt/chunkedSTT.ts
//
// ChunkedSTT = conversation manager (VAD + timing + buffering + orchestration)
// It should NOT “enhance” audio. However, in real-time systems, upstream bugs can cause
// PCM frame replay (lag-k duplication) even when the AMR storage is clean.
// This file includes an OPTIONAL, ENV-GATED defensive replay guard:
//   STT_RX_POSTPROCESS_ENABLED=true  => enables the guard
//   STT_RX_DEDUPE_WINDOW=32          => drop frames repeated within last N frames (per instance)
//
// Default behavior remains unchanged when STT_RX_POSTPROCESS_ENABLED is false.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkedSTT = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../env");
const log_1 = require("../log");
const metrics_1 = require("../metrics");
const sileroVad_1 = require("./vad/sileroVad");
const DEFAULT_PARTIAL_INTERVAL_MS = 250;
const DEFAULT_SILENCE_END_MS = 900;
const DEFAULT_PRE_ROLL_MS = 1200;
const DEFAULT_MAX_UTTERANCE_MS = 6000;
const DEFAULT_MIN_SECONDS = 0.6; // must have this much audio before partials
const DEFAULT_SILENCE_MIN_SECONDS = 0.45; // silence needed to finalize
const DEFAULT_FINAL_TAIL_CUSHION_MS = 120;
const DEFAULT_FINAL_MIN_SECONDS = 1.0;
const DEFAULT_FINAL_MIN_BYTES_FALLBACK = 0;
const DEFAULT_PARTIAL_MIN_MS = 600;
// Speech detection defaults (env.ts may override)
const DEFAULT_SPEECH_RMS_FLOOR = 0.03;
const DEFAULT_SPEECH_PEAK_FLOOR = 0.1;
const DEFAULT_SPEECH_FRAMES_REQUIRED = 8;
// Replay guard defaults
const DEFAULT_RX_DEDUPE_WINDOW = 32;
const FINAL_STOP_ABORT_GRACE_MS = 150;
// ============================================================================
// TIER_1_DYNAMIC_ENDPOINTING (ANCHOR BLOCK)
// - Adds dynamic silence finalization to prevent truncation / never-finalize
// - Replaces fixed silenceFramesNeeded logic with a curve based on speech length + RMS
// - Also enables a finalize fallback for stop/max when we have enough audio
// ============================================================================
function numEnv(key, fallback) {
    const raw = process.env[key];
    if (raw == null)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
function clampN(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}
// NOTE: we keep your existing env.STT_SILENCE_END_MS behavior as the "baseline"
// and clamp dynamic silence within min/max.
const T1_SILENCE_MIN_MS = numEnv('STT_SILENCE_DYNAMIC_MIN_MS', 220);
const T1_SILENCE_MAX_MS = numEnv('STT_SILENCE_DYNAMIC_MAX_MS', 1200);
// How much extra silence we add as speech gets longer (log curve)
const T1_SILENCE_GROWTH_MS = numEnv('STT_SILENCE_GROWTH_MS', 280);
const T1_SILENCE_LOG_K = numEnv('STT_SILENCE_LOG_K', 0.8);
// Loud speech reduces required trailing silence
const T1_LOUD_BONUS_MS = numEnv('STT_SILENCE_LOUD_BONUS_MS', 160);
const T1_LOUD_RMS_REF = numEnv('STT_SILENCE_LOUD_RMS_REF', 0.06); // RMS is normalized (0..1)
// Weak/borderline speech increases required trailing silence
const T1_WEAK_PENALTY_MS = numEnv('STT_SILENCE_WEAK_PENALTY_MS', 220);
const T1_WEAK_RMS_FLOOR = numEnv('STT_SILENCE_WEAK_RMS_FLOOR', 0.03);
// Don’t finalize unless speech actually happened (prevents finalizing on noise)
const T1_MIN_SPEECH_MS = numEnv('STT_MIN_SPEECH_MS_TO_FINALIZE', 180);
const T1_MIN_SPEECH_BYTES = numEnv('STT_MIN_SPEECH_BYTES_TO_FINALIZE', 3200);
// Optional fallback thresholds for stop/max
const T1_FALLBACK_MIN_MS = numEnv('STT_FINALIZE_FALLBACK_MIN_MS', 250);
const T1_FALLBACK_MIN_BYTES = numEnv('STT_FINALIZE_FALLBACK_MIN_BYTES', 6400);
// ============================================================================
// TIER 5: Auto-calibration + late-final watchdog
// ============================================================================
const T5_NOISE_FLOOR_ENABLED = parseBool(process.env.STT_NOISE_FLOOR_ENABLED, true);
const T5_NOISE_FLOOR_ALPHA = clampN(numEnv('STT_NOISE_FLOOR_ALPHA', 0.05), 0.01, 1);
const T5_NOISE_FLOOR_MIN_SAMPLES = numEnv('STT_NOISE_FLOOR_MIN_SAMPLES', 30);
const T5_ADAPTIVE_RMS_MULT = numEnv('STT_ADAPTIVE_RMS_MULTIPLIER', 2.0);
const T5_ADAPTIVE_PEAK_MULT = numEnv('STT_ADAPTIVE_PEAK_MULTIPLIER', 2.5);
const T5_ADAPTIVE_MIN_RMS = numEnv('STT_ADAPTIVE_FLOOR_MIN_RMS', 0.01);
const T5_ADAPTIVE_MIN_PEAK = numEnv('STT_ADAPTIVE_FLOOR_MIN_PEAK', 0.03);
const T5_LATE_FINAL_WATCHDOG_ENABLED = parseBool(process.env.STT_LATE_FINAL_WATCHDOG_ENABLED, true);
const T5_LATE_FINAL_WATCHDOG_MS = clampN(numEnv('STT_LATE_FINAL_WATCHDOG_MS', 8000), 3000, 30000);
function t1ComputeDynamicSilenceMs(args) {
    const speechMs = Math.max(0, args.speechMs);
    const avgRms = Math.max(0, args.avgRms);
    const baselineMs = Math.max(0, args.baselineMs);
    // Length curve: log1p gives short utterances quick finalize, long utterances more tail
    const lenNorm = Math.log1p(speechMs / 250) * T1_SILENCE_LOG_K; // ~0..?
    const lenExtra = clampN(lenNorm, 0, 2) * (T1_SILENCE_GROWTH_MS / 2);
    // Loudness bonus: louder => reduce required trailing silence
    const loudRatio = clampN(avgRms / Math.max(1e-6, T1_LOUD_RMS_REF), 0, 2);
    const loudBonus = loudRatio * (T1_LOUD_BONUS_MS * 0.5);
    // Weak penalty: weak => require more trailing silence
    const weakPenalty = avgRms < T1_WEAK_RMS_FLOOR ? T1_WEAK_PENALTY_MS : 0;
    const raw = baselineMs + lenExtra + weakPenalty - loudBonus;
    return clampN(raw, T1_SILENCE_MIN_MS, T1_SILENCE_MAX_MS);
}
function t1HasEnoughSpeech(args) {
    // Require BOTH time and bytes so we don't finalize on short spikes or weird buffering artifacts.
    return args.speechMs >= T1_MIN_SPEECH_MS && args.speechBytes >= T1_MIN_SPEECH_BYTES;
}
function t1ShouldFallbackFinalize(args) {
    if (!args.sawSpeech)
        return false;
    return args.totalMs >= T1_FALLBACK_MIN_MS || args.totalBytes >= T1_FALLBACK_MIN_BYTES;
}
function parseBool(value, def = false) {
    if (value == null)
        return def;
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}
function safeNum(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const v = Number(value.trim());
        if (Number.isFinite(v))
            return v;
    }
    return fallback;
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function isNonEmpty(text) {
    return normalizeWhitespace(text).length > 0;
}
function isAbortError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const name = error.name;
    return name === 'AbortError';
}
function computeRmsAndPeak(pcm16le) {
    if (pcm16le.length < 2)
        return { rms: 0, peak: 0 };
    const samples = Math.floor(pcm16le.length / 2);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples; i += 1) {
        const s = pcm16le.readInt16LE(i * 2) / 32768;
        const a = Math.abs(s);
        if (a > peak)
            peak = a;
        sumSquares += s * s;
    }
    return { rms: Math.sqrt(sumSquares / samples), peak };
}
function clampInt16(n) {
    if (n > 32767)
        return 32767;
    if (n < -32768)
        return -32768;
    return n | 0;
}
// PCMU -> PCM16LE decoding (kept here only because ingest() receives PCMU in some transports).
function muLawToPcmSample(uLawByte) {
    const u = (~uLawByte) & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const bias = 0x84;
    let sample = ((mantissa << 3) + bias) << exponent;
    sample -= bias;
    if (sign)
        sample = -sample;
    return clampInt16(sample);
}
function pcmuToPcm16le(pcmu) {
    const output = Buffer.alloc(pcmu.length * 2);
    for (let i = 0; i < pcmu.length; i += 1) {
        const sample = muLawToPcmSample(pcmu[i]);
        output.writeInt16LE(sample, i * 2);
    }
    return output;
}
function upsamplePcm16le8kTo16kLinear(pcm16le) {
    const sampleCount = Math.floor(pcm16le.length / 2);
    if (sampleCount === 0)
        return Buffer.alloc(0);
    const out = Buffer.alloc(sampleCount * 4);
    for (let i = 0; i < sampleCount - 1; i += 1) {
        const cur = pcm16le.readInt16LE(i * 2);
        const next = pcm16le.readInt16LE((i + 1) * 2);
        const interp = clampInt16(Math.round((cur + next) / 2));
        const o = i * 4;
        out.writeInt16LE(cur, o);
        out.writeInt16LE(interp, o + 2);
    }
    const last = pcm16le.readInt16LE((sampleCount - 1) * 2);
    const o = (sampleCount - 1) * 4;
    out.writeInt16LE(last, o);
    out.writeInt16LE(last, o + 2);
    return out;
}
function sha1Hex(buf) {
    return crypto_1.default.createHash('sha1').update(buf).digest('hex');
}
class ChunkedSTT {
    constructor(opts) {
        // ===== Ingest serialization (prevents async VAD/state interleaving) =====
        this.ingestChain = Promise.resolve();
        this.ingestToken = 0; // bumps on stop/reset to kill queued work
        this.vadReady = false;
        // VAD smoothing counters (optional but helps avoid flapping)
        this.vadSpeechStreak = 0;
        this.vadSilenceStreak = 0;
        this.vadSpeechNow = false;
        // VAD hysteresis thresholds (prevents flapping)
        this.vadSpeechFramesRequired = clamp(safeNum(process.env.STT_VAD_SPEECH_FRAMES_REQUIRED, 2), 1, 20);
        this.vadSilenceFramesRequired = clamp(safeNum(process.env.STT_VAD_SILENCE_FRAMES_REQUIRED, 6), 1, 50);
        this.bargeInArmed = false;
        this.bargeInSpeechStreak = 0;
        this.bargeInLastStats = { rms: 0, peak: 0 };
        this.bargeInLastFrameMs = 0;
        // State
        this.firstFrameLogged = false;
        this.inSpeech = false;
        this.lastSpeechAt = 0;
        this.lastFrameAtMs = 0;
        this.sawSpeech = false;
        this.sawSpeechEver = false; // survives utterance resets; used for call-end drain decisions
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.lastPrependedMs = 0;
        this.lastFrameMs = 0;
        this.utteranceFrames = [];
        this.speechFrameStreak = 0;
        this.playbackSpeechStreak = 0;
        this.silenceFrameStreak = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.rollingRms = 0;
        this.rollingPeak = 0;
        this.lastGateLogAtMs = 0;
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.inFlight = false;
        this.inFlightToken = 0;
        this.finalizingStop = false;
        this.finalizingStopAtMs = 0;
        this.finalizingStopSpeechStreak = 0;
        this.finalizingStopIgnoreCount = 0;
        this.recentRxHashes = [];
        this.rxFramesDropped = 0;
        this.framesSeen = 0;
        // ===== Tier 5: Noise floor estimation (adaptive thresholds) =====
        this.noiseFloorRms = 0;
        this.noiseFloorPeak = 0;
        this.noiseFloorSampleCount = 0;
        this.speechStartAtMs = 0; // used by late-final watchdog
        // ===== Playback hard-gate state =====
        this.playbackWasActive = false;
        this.playbackEndedAtMs = 0;
        this.postPlaybackGraceMs = safeNum(process.env.STT_POST_PLAYBACK_GRACE_MS, 650);
        // ===== Call-end drain window =====
        // Allow FINAL enqueue briefly after call becomes inactive, to avoid dropping the last user utterance.
        this.callEndDrainMs = safeNum(process.env.STT_CALL_END_DRAIN_MS, 1200);
        this.callInactiveAtMs = 0;
        this.provider = opts.provider;
        this.whisperUrl = opts.whisperUrl;
        this.language = opts.language;
        this.logContext = opts.logContext;
        this.tenantLabel = opts.logContext?.tenant_id ?? 'unknown';
        this.onTranscript = opts.onTranscript;
        this.onSpeechStart = opts.onSpeechStart;
        this.onUtteranceEnd = opts.onUtteranceEnd;
        this.onFinalResult = opts.onFinalResult;
        this.consumePreRoll = opts.consumePreRoll;
        // ===== BARGE-IN (NEW) =====
        this.onBargeInDetected = opts.onBargeInDetected;
        this.onSttRequestStart = opts.onSttRequestStart;
        this.onSttRequestEnd = opts.onSttRequestEnd;
        this.isPlaybackActive = opts.isPlaybackActive;
        this.isListening = opts.isListening;
        this.getTrack = opts.getTrack;
        this.getCodec = opts.getCodec;
        this.isCallActive = opts.isCallActive;
        this.getPostPlaybackGraceMs = opts.getPostPlaybackGraceMs;
        this.inputCodec = opts.inputCodec ?? 'pcmu';
        const defaultHz = this.inputCodec === 'pcm16le' ? 16000 : 8000;
        const sampleRate = safeNum(opts.sampleRate, defaultHz);
        this.sampleRate = sampleRate > 0 ? sampleRate : defaultHz;
        // PCM16LE bytes/sec (mono)
        this.bytesPerSecondPcm16 = this.sampleRate * 2;
        this.fallbackFrameMs = safeNum(opts.frameMs, env_1.env.STT_CHUNK_MS);
        const minSeconds = safeNum(env_1.env.STT_MIN_SECONDS, DEFAULT_MIN_SECONDS);
        this.minSpeechMs = Math.max(0, minSeconds) * 1000;
        // Prefer explicit millisecond silence endpointing.
        // If not set, fall back to STT_SILENCE_MIN_SECONDS -> ms.
        // Final fallback is DEFAULT_SILENCE_END_MS.
        const silenceEndMsRaw = safeNum(env_1.env.STT_SILENCE_END_MS, NaN);
        const silenceEndMsFromSeconds = Math.round(Math.max(0, safeNum(env_1.env.STT_SILENCE_MIN_SECONDS, DEFAULT_SILENCE_MIN_SECONDS)) * 1000);
        const baselineSilenceEndMs = Number.isFinite(silenceEndMsRaw) && silenceEndMsRaw > 0 ? silenceEndMsRaw : silenceEndMsFromSeconds;
        const resolvedBaselineSilenceEndMs = Number.isFinite(baselineSilenceEndMs) && baselineSilenceEndMs > 0 ? baselineSilenceEndMs : DEFAULT_SILENCE_END_MS;
        // opts override ONLY if it's a positive finite number
        const optSilenceEndMs = typeof opts.silenceEndMs === 'number' && Number.isFinite(opts.silenceEndMs) && opts.silenceEndMs > 0
            ? opts.silenceEndMs
            : undefined;
        this.silenceEndMs = clamp(optSilenceEndMs ?? resolvedBaselineSilenceEndMs, 100, 8000);
        const finalTailCushionMs = safeNum(env_1.env.FINAL_TAIL_CUSHION_MS, DEFAULT_FINAL_TAIL_CUSHION_MS);
        this.finalTailCushionMs = clamp(finalTailCushionMs, 0, 2000);
        const finalMinSeconds = safeNum(env_1.env.FINAL_MIN_SECONDS, DEFAULT_FINAL_MIN_SECONDS);
        const computedFinalMinBytes = Math.round(this.bytesPerSecondPcm16 * Math.max(0, finalMinSeconds));
        const finalMinBytes = safeNum(env_1.env.FINAL_MIN_BYTES, computedFinalMinBytes);
        this.finalMinBytes = Math.max(0, Math.round(finalMinBytes ?? DEFAULT_FINAL_MIN_BYTES_FALLBACK));
        this.partialMinMs = clamp(safeNum(env_1.env.STT_PARTIAL_MIN_MS, DEFAULT_PARTIAL_MIN_MS), 200, 5000);
        this.partialMinBytes = Math.max(0, Math.round((this.bytesPerSecondPcm16 * this.partialMinMs) / 1000));
        this.partialIntervalMs = clamp(safeNum(opts.partialIntervalMs, env_1.env.STT_PARTIAL_INTERVAL_MS ?? DEFAULT_PARTIAL_INTERVAL_MS), 100, 10000);
        this.preRollMaxMs = clamp(safeNum(opts.preRollMs, env_1.env.STT_PRE_ROLL_MS ?? DEFAULT_PRE_ROLL_MS), 0, 2000);
        this.maxUtteranceMs = clamp(safeNum(opts.maxUtteranceMs, env_1.env.STT_MAX_UTTERANCE_MS ?? DEFAULT_MAX_UTTERANCE_MS), 2000, 60000);
        this.noFrameFinalizeMs = Math.max(400, Math.min(5000, safeNum(process.env.STT_NO_FRAME_FINALIZE_MS, 1000)));
        const rmsFloorEnv = env_1.env.STT_RMS_FLOOR ?? env_1.env.STT_SPEECH_RMS_FLOOR ?? DEFAULT_SPEECH_RMS_FLOOR;
        const peakFloorEnv = env_1.env.STT_PEAK_FLOOR ?? env_1.env.STT_SPEECH_PEAK_FLOOR ?? DEFAULT_SPEECH_PEAK_FLOOR;
        this.speechRmsFloor = safeNum(opts.speechRmsFloor, rmsFloorEnv);
        this.speechPeakFloor = safeNum(opts.speechPeakFloor, peakFloorEnv);
        this.speechFramesRequired = clamp(safeNum(opts.speechFramesRequired, env_1.env.STT_SPEECH_FRAMES_REQUIRED ?? DEFAULT_SPEECH_FRAMES_REQUIRED), 1, 30);
        // honor opts override
        this.disableGates = opts.disableGates ?? (env_1.env.STT_DISABLE_GATES ?? false);
        this.vadEnabled = parseBool(process.env.STT_VAD_ENABLED, false);
        this.vadThreshold = safeNum(process.env.STT_VAD_THRESHOLD, 0.5);
        if (this.vadEnabled) {
            void sileroVad_1.SileroVad.create({ threshold: this.vadThreshold })
                .then((v) => {
                this.vad = v;
                log_1.log.info({ event: 'stt_vad_ready', threshold: this.vadThreshold, ...(this.logContext ?? {}) }, 'silero vad ready');
                this.vadReady = true;
            })
                .catch((err) => {
                log_1.log.error({ event: 'stt_vad_init_failed', err, ...(this.logContext ?? {}) }, 'silero vad init failed');
            })
                .then(() => undefined);
        }
        // Optional RX replay guard
        this.rxGuardEnabled = parseBool(process.env.STT_RX_POSTPROCESS_ENABLED, false);
        const win = Number.parseInt(process.env.STT_RX_DEDUPE_WINDOW ?? '', 10);
        this.rxDedupeWindow =
            this.rxGuardEnabled && Number.isFinite(win) && win > 0 ? win : this.rxGuardEnabled ? DEFAULT_RX_DEDUPE_WINDOW : 0;
        log_1.log.info({
            event: 'stt_tuning',
            stt_tuning: {
                input_codec: this.inputCodec,
                sample_rate_hz: this.sampleRate,
                rms_floor: this.speechRmsFloor,
                peak_floor: this.speechPeakFloor,
                frames_required: this.speechFramesRequired,
                chunk_ms: this.fallbackFrameMs,
                partial_interval_ms: this.partialIntervalMs,
                partial_min_ms: this.partialMinMs,
                pre_roll_ms: this.preRollMaxMs,
                silence_end_ms: this.silenceEndMs,
                max_utt_ms: this.maxUtteranceMs,
                final_tail_cushion_ms: this.finalTailCushionMs,
                final_min_bytes: this.finalMinBytes,
                disable_gates: this.disableGates,
                rx_guard_enabled: this.rxGuardEnabled,
                rx_dedupe_window: this.rxDedupeWindow,
                post_playback_grace_ms: this.postPlaybackGraceMs,
                post_playback_grace_dynamic: !!this.getPostPlaybackGraceMs,
                no_frame_finalize_ms: this.noFrameFinalizeMs,
                noise_floor_enabled: T5_NOISE_FLOOR_ENABLED,
                late_final_watchdog_enabled: T5_LATE_FINAL_WATCHDOG_ENABLED,
                late_final_watchdog_ms: T5_LATE_FINAL_WATCHDOG_MS,
            },
            ...(this.logContext ?? {}),
        }, 'stt tuning');
        // Partial tick is OPTIONAL now.
        // With CallSession running a final-only turn policy, partials just add load and can delay finals.
        // Enable explicitly with: STT_PARTIALS_ENABLED=true
        const partialsEnabled = parseBool(process.env.STT_PARTIALS_ENABLED, false);
        if (partialsEnabled) {
            this.timer = setInterval(() => {
                try {
                    this.flushIfReady('interval');
                }
                catch (err) {
                    log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt interval flush failed');
                }
            }, this.partialIntervalMs);
        }
        else {
            this.timer = undefined;
            this.noFrameCheckTimer = setInterval(() => {
                try {
                    this.checkNoFrameFinalize();
                }
                catch (err) {
                    log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt no-frame check failed');
                }
            }, 400);
            log_1.log.info({ event: 'stt_partials_disabled', no_frame_finalize_ms: this.noFrameFinalizeMs, ...(this.logContext ?? {}) }, 'stt partial timer disabled (final-only policy)');
        }
    }
    checkNoFrameFinalize() {
        if (!this.inSpeech || this.utteranceBytes <= 0 || this.playbackGateActive())
            return;
        const now = this.nowMs();
        const speechMs = Math.max(0, this.utteranceMs - this.lastPrependedMs);
        // Tier 5: Late-final watchdog — speech has been ongoing too long without finalizing
        if (T5_LATE_FINAL_WATCHDOG_ENABLED && this.speechStartAtMs > 0) {
            const elapsedSinceSpeechStart = now - this.speechStartAtMs;
            if (elapsedSinceSpeechStart >= T5_LATE_FINAL_WATCHDOG_MS &&
                t1HasEnoughSpeech({ speechMs, speechBytes: this.utteranceBytes })) {
                this.silenceToFinalizeTimer?.();
                this.silenceToFinalizeTimer = undefined;
                log_1.log.info({
                    event: 'stt_late_final_watchdog',
                    reason: 'watchdog',
                    elapsed_since_speech_start_ms: Math.round(elapsedSinceSpeechStart),
                    watchdog_ms: T5_LATE_FINAL_WATCHDOG_MS,
                    speech_ms: Math.round(speechMs),
                    speech_bytes: this.utteranceBytes,
                    ...(this.logContext ?? {}),
                }, 'stt late-final watchdog (force final)');
                this.finalizeUtterance('silence');
                return;
            }
        }
        // Original: no frames received for noFrameFinalizeMs
        if (now - this.lastFrameAtMs < this.noFrameFinalizeMs)
            return;
        if (!t1HasEnoughSpeech({ speechMs, speechBytes: this.utteranceBytes }))
            return;
        this.silenceToFinalizeTimer?.();
        this.silenceToFinalizeTimer = undefined;
        log_1.log.info({
            event: 'stt_no_frame_finalize',
            reason: 'no_frames',
            no_frame_ms: Math.round(now - this.lastFrameAtMs),
            no_frame_finalize_ms: this.noFrameFinalizeMs,
            speech_ms: Math.round(speechMs),
            speech_bytes: this.utteranceBytes,
            ...(this.logContext ?? {}),
        }, 'stt finalize (no frames received)');
        this.finalizeUtterance('silence');
    }
    // Direct PCM16 ingest (already decoded elsewhere).
    ingestPcm16(pcm16, sampleRateHz) {
        if (!pcm16 || pcm16.length === 0)
            return;
        if (sampleRateHz !== this.sampleRate) {
            log_1.log.warn({
                event: 'chunked_stt_sample_rate_mismatch',
                expected_hz: this.sampleRate,
                got_hz: sampleRateHz,
                ...(this.logContext ?? {}),
            }, 'chunked stt sample rate mismatch');
            return;
        }
        // IMPORTANT: Buffer.from(Int16Array) treats values as bytes (WRONG).
        // Create a Buffer view over the underlying ArrayBuffer, then COPY.
        const view = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        const frame = Buffer.from(view);
        const computedFrameMs = (pcm16.length / sampleRateHz) * 1000;
        const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0 ? computedFrameMs : this.fallbackFrameMs;
        if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            log_1.log.info({
                event: 'stt_first_pcm16_frame',
                input_codec: 'pcm16le',
                int16_len: pcm16.length,
                input_bytes: frame.length,
                sample_rate_hz: sampleRateHz,
                computed_frame_ms: Math.round(frameMs),
                ...(this.logContext ?? {}),
            }, 'stt first pcm16 frame');
        }
        this.enqueueIngestDecodedPcm16(frame, frameMs);
    }
    // Unified ingest for either PCMU or PCM16LE input.
    ingest(input) {
        if (!input || input.length === 0)
            return;
        const bytesPerSampleIn = this.inputCodec === 'pcmu' ? 1 : 2;
        const samples = input.length / bytesPerSampleIn;
        const computedFrameMs = (samples / this.sampleRate) * 1000;
        const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0 ? computedFrameMs : this.fallbackFrameMs;
        if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            const computedSamples = input.length / bytesPerSampleIn;
            log_1.log.info({
                event: 'stt_first_audio_frame',
                input_codec: this.inputCodec,
                input_bytes: input.length,
                bytes_per_sample_in: bytesPerSampleIn,
                computed_samples: computedSamples,
                sample_rate_hz: this.sampleRate,
                computed_frame_ms: Math.round(frameMs),
                silence_end_ms: this.silenceEndMs,
                partial_interval_ms: this.partialIntervalMs,
                ...(this.logContext ?? {}),
            }, 'stt first audio frame');
        }
        let framePcm16;
        if (this.inputCodec === 'pcmu') {
            framePcm16 = pcmuToPcm16le(input);
        }
        else {
            // passthrough, but COPY so we don't retain a pooled/reused buffer
            framePcm16 = Buffer.from(input);
        }
        this.enqueueIngestDecodedPcm16(framePcm16, frameMs);
    }
    enqueueIngestDecodedPcm16(pcm16, frameMs) {
        const token = this.ingestToken;
        this.ingestChain = this.ingestChain
            .then(async () => {
            if (token !== this.ingestToken)
                return;
            await this.ingestDecodedPcm16(pcm16, frameMs);
        })
            .catch((err) => {
            log_1.log.error({ event: 'stt_ingest_chain_error', err, ...(this.logContext ?? {}) }, 'stt ingest chain error');
        });
    }
    nowMs() {
        return Date.now();
    }
    allowFinalDuringCallEndDrain(kind) {
        if (kind !== 'final')
            return false;
        if (!this.isCallActive)
            return false;
        const active = this.isCallActive();
        const now = this.nowMs();
        if (active) {
            this.callInactiveAtMs = 0;
            return true;
        }
        // call is inactive
        if (this.callInactiveAtMs === 0)
            this.callInactiveAtMs = now;
        // Only allow if we actually had speech (prevents garbage finals)
        if (!this.sawSpeechEver)
            return false;
        return now - this.callInactiveAtMs <= this.callEndDrainMs;
    }
    playbackGateActive() {
        if (this.disableGates)
            return false;
        const active = !!this.isPlaybackActive?.();
        if (active)
            return true;
        // Once we're actively listening, don't keep gating on post-playback grace.
        // This prevents speech during the grace window from being swallowed.
        if (this.isListening?.())
            return false;
        if (this.playbackEndedAtMs > 0) {
            const graceMs = this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs;
            const since = this.nowMs() - this.playbackEndedAtMs;
            if (since >= 0 && since < graceMs)
                return true;
        }
        return false;
    }
    handlePlaybackTransitionIfNeeded() {
        if (this.disableGates)
            return;
        const active = !!this.isPlaybackActive?.();
        // PLAYBACK STARTED
        if (active && !this.playbackWasActive) {
            this.playbackWasActive = true;
            this.bargeInArmed = false;
            this.bargeInSpeechStreak = 0;
            this.bargeInLastStats = { rms: 0, peak: 0 };
            this.bargeInLastFrameMs = 0;
            this.preRollFrames = [];
            this.preRollMs = 0;
            if (this.inFlight)
                this.abortInFlight('finalize');
            if (this.inSpeech)
                this.resetUtteranceState();
            this.vadSpeechNow = false;
            this.vadSpeechStreak = 0;
            this.vadSilenceStreak = 0;
            if (this.vad)
                this.vad.reset();
            this.recentRxHashes.length = 0;
        }
        // PLAYBACK ENDED
        if (!active && this.playbackWasActive) {
            this.playbackWasActive = false;
            this.playbackEndedAtMs = this.nowMs();
            this.playbackSpeechStreak = 0;
            this.vadSpeechNow = false;
            this.vadSpeechStreak = 0;
            this.vadSilenceStreak = 0;
            if (this.vad)
                this.vad.reset();
            this.recentRxHashes.length = 0;
            // ===== BARGE-IN HANDOFF =====
            if (this.bargeInArmed &&
                this.bargeInSpeechStreak >= this.speechFramesRequired &&
                !this.inSpeech &&
                this.preRollFrames.length > 0) {
                const frameMs = this.bargeInLastFrameMs > 0 ? this.bargeInLastFrameMs : this.fallbackFrameMs;
                const stats = this.bargeInLastStats.rms > 0
                    ? this.bargeInLastStats
                    : { rms: this.rollingRms, peak: this.rollingPeak };
                log_1.log.info({
                    event: 'stt_barge_in_handoff',
                    pre_roll_frames: this.preRollFrames.length,
                    pre_roll_ms: Math.round(this.preRollMs),
                    frame_ms: Math.round(frameMs),
                    rms: Number(stats.rms.toFixed(4)),
                    peak: Number(stats.peak.toFixed(4)),
                    streak: this.bargeInSpeechStreak,
                    ...(this.logContext ?? {}),
                }, 'barge-in handoff: entering speech after playback ended');
                this.speechFrameStreak = this.speechFramesRequired;
                this.startSpeech(stats, frameMs);
            }
            // reset barge-in state for next playback segment
            this.bargeInArmed = false;
            this.bargeInSpeechStreak = 0;
            this.bargeInLastStats = { rms: 0, peak: 0 };
            this.bargeInLastFrameMs = 0;
        }
    }
    // Optional defensive replay guard: drops identical frames repeated within last N frames.
    shouldDropRxFrame(pcm16) {
        if (!this.rxGuardEnabled || this.rxDedupeWindow <= 0)
            return { drop: false, sha1_10: '' };
        const h = sha1Hex(pcm16);
        const h10 = h.slice(0, 10);
        const recent = this.recentRxHashes;
        for (let i = recent.length - 1, lag = 1; i >= 0 && lag <= this.rxDedupeWindow; i -= 1, lag += 1) {
            if (recent[i] === h)
                return { drop: true, sha1_10: h10, matchedLag: lag };
        }
        recent.push(h);
        if (recent.length > this.rxDedupeWindow)
            recent.shift();
        return { drop: false, sha1_10: h10 };
    }
    // Post-decode path (PCM16LE mono @ this.sampleRate)
    async ingestDecodedPcm16(pcm16, frameMs) {
        this.lastFrameAtMs = this.nowMs();
        // Detect playback transitions & enforce boundary resets.
        this.handlePlaybackTransitionIfNeeded();
        // Keep call-end drain state correct across call lifecycle transitions
        if (this.isCallActive?.()) {
            this.callInactiveAtMs = 0;
        }
        this.lastFrameMs = frameMs;
        // ===== HARD GATE during playback (and brief grace after) =====
        // IMPORTANT: We still run VAD/speech detection during playback so barge-in works.
        // We only block *buffering/transcription* during playback/grace.
        const gatedForPlayback = this.playbackGateActive();
        // Once grace has elapsed, clear the marker.
        if (!this.disableGates && this.playbackEndedAtMs > 0) {
            const graceMs = this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs;
            const since = this.nowMs() - this.playbackEndedAtMs;
            if (since >= graceMs)
                this.playbackEndedAtMs = 0;
        }
        // ===== Replay guard here (before any VAD/state) =====
        // Goal:
        // - If playback-gated: skip RX guard & counters (we return later anyway)
        // - If RX guard enabled: drop frames repeated within last N frames
        // - Always advance rxFramesKept for non-gated frames so log throttles behave
        if (!gatedForPlayback) {
            if (this.rxGuardEnabled) {
                const guard = this.shouldDropRxFrame(pcm16);
                if (guard.drop) {
                    this.rxFramesDropped += 1;
                    if (this.rxFramesDropped <= 20 || this.rxFramesDropped % 100 === 0) {
                        log_1.log.warn({
                            event: 'stt_rx_replay_dropped',
                            matched_lag: guard.matchedLag,
                            sha1_10: guard.sha1_10,
                            dropped: this.rxFramesDropped,
                            kept: this.framesSeen,
                            rx_dedupe_window: this.rxDedupeWindow,
                            ...(this.logContext ?? {}),
                        }, 'dropping replayed PCM frame before ChunkedSTT buffering');
                    }
                    return; // critical: do NOT continue into VAD/buffering
                }
                // Guard enabled and frame not dropped
                this.framesSeen += 1;
            }
            else {
                // Guard disabled: still advance for log throttling / observability
                this.framesSeen += 1;
            }
        }
        const stats = computeRmsAndPeak(pcm16);
        this.updateRollingStats(stats);
        // Tier 5: Update noise floor from pre-speech frames (ambient, not gated)
        if (T5_NOISE_FLOOR_ENABLED && !gatedForPlayback && !this.inSpeech) {
            const alpha = T5_NOISE_FLOOR_ALPHA;
            this.noiseFloorSampleCount += 1;
            if (this.noiseFloorSampleCount >= T5_NOISE_FLOOR_MIN_SAMPLES) {
                this.noiseFloorRms =
                    this.noiseFloorRms === 0
                        ? stats.rms
                        : this.noiseFloorRms * (1 - alpha) + stats.rms * alpha;
                this.noiseFloorPeak =
                    this.noiseFloorPeak === 0
                        ? stats.peak
                        : this.noiseFloorPeak * (1 - alpha) + stats.peak * alpha;
            }
        }
        // Tier 5: Adaptive floors when noise floor is available
        const effectiveRmsFloor = this.getEffectiveRmsFloor();
        const effectivePeakFloor = this.getEffectivePeakFloor();
        const gateRms = stats.rms >= effectiveRmsFloor;
        const gatePeak = stats.peak >= effectivePeakFloor;
        // === VAD: speech decision ===
        if (this.vadEnabled && this.vadReady && this.vad) {
            const pcmForVad = this.sampleRate === 16000
                ? pcm16
                : this.sampleRate === 8000
                    ? upsamplePcm16le8kTo16kLinear(pcm16)
                    : null;
            if (pcmForVad) {
                const res = await this.vad.pushPcm16le16k(pcmForVad);
                if (res) {
                    this.vadSpeechNow = !!res.isSpeech;
                    if (res.isSpeech) {
                        this.vadSpeechStreak += 1;
                        this.vadSilenceStreak = 0;
                    }
                    else {
                        this.vadSilenceStreak += 1;
                        this.vadSpeechStreak = 0;
                    }
                }
            }
        }
        let vadSpeechDecision = null;
        if (this.vadEnabled && this.vadReady && this.vad) {
            if (this.vadSpeechStreak >= this.vadSpeechFramesRequired)
                vadSpeechDecision = true;
            else if (this.vadSilenceStreak >= this.vadSilenceFramesRequired)
                vadSpeechDecision = false;
            else
                vadSpeechDecision = this.vadSpeechNow;
        }
        const isSpeech = this.disableGates ? true : (vadSpeechDecision ?? (gateRms && gatePeak));
        if (isSpeech && !gatedForPlayback) {
            this.sawSpeech = true;
            this.sawSpeechEver = true;
        }
        if (this.finalizingStop && !isSpeech) {
            this.finalizingStopSpeechStreak = 0;
        }
        // ===== BARGE-IN ON =====
        // During playback/grace:
        // - keep rolling stats
        // - detect speech and arm barge-in
        // - once armed, buffer ONLY post-arm frames as pre-roll for handoff
        if (gatedForPlayback) {
            // Track stats for potential handoff
            this.bargeInLastStats = { rms: stats.rms, peak: stats.peak };
            this.bargeInLastFrameMs = frameMs;
            if (isSpeech) {
                // build confidence
                this.bargeInSpeechStreak += 1;
                // Arm once we’ve seen enough consecutive speech frames
                if (!this.bargeInArmed && this.bargeInSpeechStreak >= this.speechFramesRequired) {
                    this.bargeInArmed = true;
                    // IMPORTANT: once armed, start a clean pre-roll buffer (no assistant leakage)
                    this.preRollFrames = [];
                    this.preRollMs = 0;
                    log_1.log.info({
                        event: 'stt_barge_in_detected',
                        rms: Number(stats.rms.toFixed(4)),
                        peak: Number(stats.peak.toFixed(4)),
                        frame_ms: Math.round(frameMs),
                        streak: this.bargeInSpeechStreak,
                        ...(this.logContext ?? {}),
                    }, 'barge-in detected during playback (armed)');
                    this.onBargeInDetected?.({
                        rms: stats.rms,
                        peak: stats.peak,
                        frameMs,
                        streak: this.bargeInSpeechStreak,
                        duringPlayback: true,
                    });
                    // Don’t let any in-flight STT “win” during a barge-in
                    if (this.inFlight)
                        this.abortInFlight('barge_in');
                }
                // Once armed, buffer user lead-in frames (rolling)
                if (this.bargeInArmed) {
                    this.addPreRollFrame(pcm16, frameMs);
                }
            }
            else {
                // Speech flicker during playback: decay instead of hard reset (more reliable)
                this.bargeInSpeechStreak = Math.max(0, this.bargeInSpeechStreak - 1);
                // While playback is active and we haven't armed barge-in yet, DO NOT buffer pre-roll
                // (prevents assistant audio polluting the future handoff)
            }
            return;
        }
        if (!this.disableGates && (this.framesSeen <= 20 || this.framesSeen % 100 === 0)) {
            log_1.log.info({
                event: 'stt_speech_decision',
                is_speech: isSpeech,
                vad_enabled: this.vadEnabled && this.vadReady,
                vad_raw: this.vadSpeechNow,
                vad_speech_streak: this.vadSpeechStreak,
                vad_silence_streak: this.vadSilenceStreak,
                vad_speech_req: this.vadSpeechFramesRequired,
                vad_silence_req: this.vadSilenceFramesRequired,
                vad_decision: vadSpeechDecision,
                gate_rms: gateRms,
                gate_peak: gatePeak,
                rms: stats.rms,
                peak: stats.peak,
                ...(this.logContext ?? {}),
            }, 'stt speech decision');
        }
        // Barge-in: if final request is in-flight and speech resumes, abort and reset.
        if (this.inFlight && this.inFlightKind === 'final' && isSpeech) {
            if (this.finalizingStop) {
                const now = this.nowMs();
                const elapsed = now - this.finalizingStopAtMs;
                if (elapsed < FINAL_STOP_ABORT_GRACE_MS) {
                    this.finalizingStopIgnoreCount += 1;
                    if (this.finalizingStopIgnoreCount <= 3 || this.finalizingStopIgnoreCount % 50 === 0) {
                        log_1.log.info({
                            event: 'stt_abort_final_ignored_during_stop',
                            reason: 'within_grace',
                            elapsed_ms: Math.round(elapsed),
                            streak: this.finalizingStopSpeechStreak,
                            frames_required: this.speechFramesRequired,
                            ...(this.logContext ?? {}),
                        }, 'ignoring final abort during stop grace');
                    }
                }
                else {
                    this.finalizingStopSpeechStreak += 1;
                    if (this.finalizingStopSpeechStreak >= this.speechFramesRequired) {
                        this.finalizingStop = false;
                        this.finalizingStopAtMs = 0;
                        this.finalizingStopSpeechStreak = 0;
                        this.finalizingStopIgnoreCount = 0;
                        this.abortInFlight('barge_in');
                        this.resetUtteranceState();
                        return;
                    }
                    this.finalizingStopIgnoreCount += 1;
                    if (this.finalizingStopIgnoreCount <= 3 || this.finalizingStopIgnoreCount % 50 === 0) {
                        log_1.log.info({
                            event: 'stt_abort_final_ignored_during_stop',
                            reason: 'awaiting_streak',
                            elapsed_ms: Math.round(elapsed),
                            streak: this.finalizingStopSpeechStreak,
                            frames_required: this.speechFramesRequired,
                            ...(this.logContext ?? {}),
                        }, 'ignoring final abort during stop (waiting for new utterance)');
                    }
                }
            }
            else {
                this.abortInFlight('barge_in');
                this.resetUtteranceState();
                return;
            }
        }
        // Not in speech yet: build pre-roll and detect start
        if (!this.inSpeech) {
            this.addPreRollFrame(pcm16, frameMs);
            if (isSpeech) {
                this.silenceFrameStreak = 0;
                this.silenceToFinalizeTimer = undefined;
                this.speechFrameStreak += 1;
            }
            else {
                this.speechFrameStreak = 0;
            }
            if (isSpeech && this.speechFrameStreak >= this.speechFramesRequired) {
                this.startSpeech(stats, frameMs);
            }
            else if (!this.disableGates) {
                const reason = this.resolveGateClosedReason(gateRms, gatePeak, this.speechFrameStreak);
                if (reason)
                    this.maybeLogGateClosed(reason, stats, frameMs);
            }
            return;
        }
        // In speech: append frames and decide when to finalize
        this.appendUtterance(pcm16, frameMs);
        if (isSpeech) {
            this.lastSpeechAt = this.nowMs();
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
        else {
            if (this.silenceFrameStreak === 0) {
                this.silenceToFinalizeTimer = (0, metrics_1.startStageTimer)('stt_silence_to_finalize_ms', this.tenantLabel);
            }
            this.silenceFrameStreak += 1;
            // ============================================================================
            // TIER_1_DYNAMIC_ENDPOINTING (DROP-IN)
            // - dynamic trailing-silence requirement based on utterance length + rolling RMS
            // - prevents truncation and “never finalize” in noisier environments
            //
            // Requires these helper functions to exist in this file (top-level):
            //   - t1ComputeDynamicSilenceMs({ speechMs, avgRms, baselineMs })
            //   - t1HasEnoughSpeech({ speechMs, speechBytes })
            // (If you used the earlier helper block, you're good.)
            // ============================================================================
            const speechMs = Math.max(0, this.utteranceMs - this.lastPrependedMs);
            const speechBytes = this.utteranceBytes;
            // utteranceMs includes pre-roll; that's OK (we're only deciding how long to wait after last speech)
            const avgRms = this.rollingRms; // already updated each frame via updateRollingStats()
            const dynamicSilenceMs = t1ComputeDynamicSilenceMs({ speechMs, avgRms, baselineMs: this.silenceEndMs });
            const silenceMsSoFar = this.silenceFrameStreak * frameMs;
            const okToFinalize = t1HasEnoughSpeech({ speechMs, speechBytes });
            if (okToFinalize && silenceMsSoFar >= dynamicSilenceMs) {
                this.silenceToFinalizeTimer?.();
                this.silenceToFinalizeTimer = undefined;
                log_1.log.info({
                    event: 'stt_dynamic_finalize',
                    reason: 'silence_dynamic',
                    speech_ms: Math.round(speechMs),
                    speech_bytes: speechBytes,
                    silence_ms: Math.round(silenceMsSoFar),
                    dynamic_silence_ms: Math.round(dynamicSilenceMs),
                    rolling_rms: Number(this.rollingRms.toFixed(4)),
                    rolling_peak: Number(this.rollingPeak.toFixed(4)),
                    silence_end_ms: this.silenceEndMs,
                    ...(this.logContext ?? {}),
                }, 'stt dynamic finalize (tier1)');
                this.finalizeUtterance('silence');
                return;
            }
        }
        if (this.utteranceMs >= this.maxUtteranceMs) {
            this.finalizeUtterance('max');
            return;
        }
    }
    async stop(options = {}) {
        this.ingestToken += 1;
        const chain = this.ingestChain;
        this.ingestChain = Promise.resolve();
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        if (this.noFrameCheckTimer) {
            clearInterval(this.noFrameCheckTimer);
            this.noFrameCheckTimer = undefined;
        }
        try {
            await chain;
        }
        catch { /* ignore */ }
        const allowFinal = options.allowFinal ?? true;
        const preserveInFlightFinal = options.preserveInFlightFinal ?? false;
        let queuedFinal = false;
        if (allowFinal && this.inSpeech && this.utteranceBytes > 0) {
            // finalizeUtterance('stop') will enqueue a final if it passes fallback checks
            this.flushIfReady('stop');
            queuedFinal = true;
        }
        // If we just queued a final, DO NOT abort it.
        // Only abort if nothing was queued and we’re just shutting down.
        if (!queuedFinal) {
            if (!(preserveInFlightFinal && this.inFlight && this.inFlightKind === 'final')) {
                this.abortInFlight('finalize');
            }
        }
        // If playback/grace gate is active, don't wipe buffered speech here.
        // finalizeUtterance() will refuse to send during gate; wiping here loses the last utterance.
        const gated = this.playbackGateActive();
        if (!gated) {
            this.resetUtteranceState();
        }
        this.bargeInArmed = false;
        this.bargeInSpeechStreak = 0;
        this.bargeInLastStats = { rms: 0, peak: 0 };
        this.bargeInLastFrameMs = 0;
        this.playbackWasActive = false;
        this.playbackEndedAtMs = 0;
    }
    flushIfReady(reason) {
        // Interval is only for partials; finalization still happens via silence/max/stop.
        if (reason === 'interval') {
            const partialsEnabled = parseBool(process.env.STT_PARTIALS_ENABLED, false);
            if (!partialsEnabled)
                return;
            return void this.maybeSendPartial();
        }
        if (reason === 'stop')
            return void this.finalizeUtterance('stop');
        this.finalizeUtterance('silence');
    }
    addPreRollFrame(pcm16, frameMs) {
        if (this.preRollMaxMs <= 0)
            return;
        const snap = Buffer.from(pcm16);
        this.preRollFrames.push({ buffer: snap, ms: frameMs });
        this.preRollMs += frameMs;
        while (this.preRollMs > this.preRollMaxMs && this.preRollFrames.length > 0) {
            const dropped = this.preRollFrames.shift();
            if (!dropped)
                break;
            this.preRollMs -= dropped.ms;
        }
    }
    startSpeech(stats, frameMs) {
        this.inSpeech = true;
        this.speechStartAtMs = this.nowMs(); // Tier 5: late-final watchdog baseline
        this.noiseFloorSampleCount = 0; // Tier 5: reset so next utterance re-estimates noise floor
        // ✅ FIX: ensure Tier1 fallback finalize logic knows we truly saw speech
        // (prevents stop/max from skipping finalize when speech started and ended quickly)
        this.sawSpeech = true;
        this.sawSpeechEver = true;
        this.lastSpeechAt = this.nowMs();
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        let selectedFrames = this.preRollFrames;
        let selectedMs = this.preRollMs;
        const external = this.consumePreRoll?.();
        if (external && external.frames.length > 0 && external.sampleRateHz === this.sampleRate) {
            selectedFrames = external.frames;
            selectedMs = external.totalMs;
        }
        const prependedMs = selectedMs;
        const prependedFrames = selectedFrames.length;
        this.lastPrependedMs = prependedMs;
        this.utteranceFrames = [...selectedFrames];
        this.utteranceMs = selectedMs;
        this.utteranceBytes = this.utteranceFrames.reduce((sum, f) => sum + f.buffer.length, 0);
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        log_1.log.info({
            event: 'stt_utterance_start',
            prepended_ms: Math.round(prependedMs),
            preroll_frames: prependedFrames,
            sample_rate_hz: this.sampleRate,
            ts: this.nowMs(),
            ...(this.logContext ?? {}),
        }, 'stt utterance start');
        this.onSpeechStart?.({
            rms: stats.rms,
            peak: stats.peak,
            frameMs,
            streak: this.speechFrameStreak,
            prependedMs: Math.round(prependedMs),
        });
        log_1.log.info({
            event: 'stt_speech_start',
            speech_rms: Number(stats.rms.toFixed(4)),
            speech_peak: Number(stats.peak.toFixed(4)),
            frame_ms: Math.round(frameMs),
            ...(this.logContext ?? {}),
        }, 'stt speech start');
    }
    appendUtterance(pcm16, frameMs) {
        const snap = Buffer.from(pcm16);
        this.utteranceFrames.push({ buffer: snap, ms: frameMs });
        this.utteranceMs += frameMs;
        this.utteranceBytes += snap.length;
    }
    trimTrailingSilence(frames) {
        if (frames.length === 0)
            return frames;
        let lastSpeechIndex = -1;
        for (let i = frames.length - 1; i >= 0; i -= 1) {
            const stats = computeRmsAndPeak(frames[i].buffer);
            if (stats.rms >= this.speechRmsFloor && stats.peak >= this.speechPeakFloor) {
                lastSpeechIndex = i;
                break;
            }
        }
        if (lastSpeechIndex === -1)
            return frames;
        let endIndex = lastSpeechIndex;
        let tailMs = 0;
        for (let i = lastSpeechIndex + 1; i < frames.length; i += 1) {
            tailMs += frames[i].ms;
            endIndex = i;
            if (tailMs >= this.finalTailCushionMs)
                break;
        }
        if (endIndex >= frames.length - 1)
            return frames;
        return frames.slice(0, endIndex + 1);
    }
    maybeSendPartial() {
        if (!this.inSpeech)
            return;
        if (this.inFlight)
            return;
        // ✅ NEW: never send partials during playback/grace
        this.handlePlaybackTransitionIfNeeded();
        if (this.playbackGateActive())
            return;
        if (this.utteranceMs < this.minSpeechMs)
            return;
        const now = this.nowMs();
        if (this.lastPartialAt > 0 && now - this.lastPartialAt < this.partialIntervalMs)
            return;
        const payload = this.concatFrames(this.utteranceFrames);
        if (payload.length < this.partialMinBytes)
            return;
        this.lastPartialAt = now;
        this.enqueueTranscription(payload, { reason: 'partial', isFinal: false });
    }
    finalizeUtterance(reason) {
        // ============================================================================
        // TIER_1_DYNAMIC_ENDPOINTING (ANCHOR FALLBACK)
        // If stop/max happens, only finalize if we have enough real speech.
        // Otherwise skip finalizing and reset state (prevents garbage finals).
        // ============================================================================
        if (reason === 'stop' || reason === 'max') {
            const totalMs = this.utteranceMs;
            const totalBytes = this.utteranceBytes;
            const enough = t1ShouldFallbackFinalize({
                totalMs,
                totalBytes,
                sawSpeech: this.sawSpeech,
            });
            if (!enough) {
                log_1.log.info({
                    event: 'stt_finalize_fallback_skipped',
                    reason,
                    total_ms: Math.round(totalMs),
                    total_bytes: totalBytes,
                    ...(this.logContext ?? {}),
                }, 'stt finalize fallback skipped (tier1)');
                this.resetUtteranceState();
                return;
            }
            log_1.log.info({
                event: 'stt_finalize_fallback',
                reason,
                total_ms: Math.round(totalMs),
                total_bytes: totalBytes,
                ...(this.logContext ?? {}),
            }, 'stt finalize fallback (tier1)');
        }
        if (!this.inSpeech || this.utteranceBytes === 0)
            return;
        // ✅ NEW: never finalize during playback/grace
        this.handlePlaybackTransitionIfNeeded();
        // ✅ FIX: never finalize during playback/grace
        if (this.playbackGateActive()) {
            // During playback/grace, do not finalize or send STT.
            // Keep buffering state so we can finalize once gate clears.
            return;
        }
        if (this.finalFlushAt === 0) {
            this.finalFlushAt = this.nowMs();
            if (reason === 'silence' && this.lastSpeechAt > 0) {
                (0, metrics_1.observeStageDuration)('pre_stt_gate', this.tenantLabel, this.nowMs() - this.lastSpeechAt);
            }
        }
        if (this.inFlight) {
            if (this.inFlightKind === 'final')
                return;
            this.abortInFlight('finalize');
        }
        const trimmedFrames = this.trimTrailingSilence(this.utteranceFrames);
        const payload = this.concatFrames(trimmedFrames);
        log_1.log.info({
            event: 'stt_finalize_payload_stats',
            reason,
            frames: trimmedFrames.length,
            utterance_ms: Math.round((payload.length / this.bytesPerSecondPcm16) * 1000),
            bytes: payload.length,
            silence_end_ms: this.silenceEndMs,
            min_speech_ms: this.minSpeechMs,
            final_min_bytes: this.finalMinBytes,
            ...(this.logContext ?? {}),
        }, 'finalizing utterance payload');
        const utteranceTotalMs = Math.max(0, Math.round(this.utteranceMs));
        const preRollMs = Math.max(0, Math.round(this.lastPrependedMs));
        const frameMs = this.lastFrameMs > 0 ? this.lastFrameMs : this.fallbackFrameMs;
        const trailingSilenceMs = Math.max(0, Math.round(Math.min(this.utteranceMs, this.silenceFrameStreak * frameMs)));
        const speechMs = Math.max(0, Math.round(this.utteranceMs - preRollMs - trailingSilenceMs));
        this.onUtteranceEnd?.({
            preRollMs,
            utteranceMs: utteranceTotalMs,
            speechMs,
            trailingSilenceMs,
        });
        this.enqueueTranscription(payload, {
            reason: 'final',
            isFinal: true,
            finalReason: reason,
        });
        this.resetUtteranceState();
    }
    concatFrames(frames) {
        if (frames.length === 1)
            return frames[0].buffer;
        return Buffer.concat(frames.map((f) => f.buffer));
    }
    abortInFlight(reason) {
        if (!this.inFlight)
            return;
        const kind = this.inFlightKind;
        this.inFlightAbort?.abort();
        this.inFlightAbort = undefined;
        this.inFlight = false;
        this.inFlightKind = undefined;
        this.finalizeToResultTimer = undefined;
        this.finalFlushAt = 0;
        this.inFlightToken += 1;
        if (kind === 'final') {
            this.finalizingStop = false;
            this.finalizingStopAtMs = 0;
            this.finalizingStopSpeechStreak = 0;
            this.finalizingStopIgnoreCount = 0;
        }
        // ✅ ensure CallSession always sees the "end"
        if (kind)
            this.onSttRequestEnd?.(kind);
        if (reason === 'barge_in') {
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
    }
    enqueueTranscription(payloadPcm16, meta) {
        // ✅ CALL LIFECYCLE GATE: do not enqueue STT if call is already ended/inactive
        if (this.isCallActive && !this.isCallActive()) {
            const allow = this.allowFinalDuringCallEndDrain(meta.reason);
            if (!allow) {
                log_1.log.info({
                    event: 'stt_skip_transcription_call_inactive',
                    kind: meta.reason,
                    payload_bytes: payloadPcm16.length,
                    saw_speech: this.sawSpeech,
                    drain_ms: this.callEndDrainMs,
                    inactive_at_ms: this.callInactiveAtMs,
                    now_ms: this.nowMs(),
                    ...(this.logContext ?? {}),
                }, 'skipping STT enqueue because call is inactive');
                return;
            }
            log_1.log.warn({
                event: 'stt_call_end_drain_allow',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                saw_speech: this.sawSpeech,
                drain_ms: this.callEndDrainMs,
                inactive_at_ms: this.callInactiveAtMs,
                now_ms: this.nowMs(),
                ...(this.logContext ?? {}),
            }, 'allowing FINAL STT during call-end drain window');
        }
        // 1) If we’re already sending something, log it (otherwise Whisper will never move)
        if (this.inFlight) {
            log_1.log.info({
                event: 'stt_enqueue_skipped_inflight',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                in_flight_kind: this.inFlightKind,
                ...(this.logContext ?? {}),
            }, 'stt enqueue skipped (already in-flight)');
            return;
        }
        // ✅ safety net
        this.handlePlaybackTransitionIfNeeded();
        // 2) If playback gate is active, log WHY we are blocked
        if (this.playbackGateActive()) {
            log_1.log.warn({
                event: 'stt_enqueue_blocked_by_playback_gate',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                playback_active: !!this.isPlaybackActive?.(),
                playback_ended_at_ms: this.playbackEndedAtMs,
                post_playback_grace_ms: this.postPlaybackGraceMs,
                now_ms: this.nowMs(),
                ...(this.logContext ?? {}),
            }, 'stt enqueue blocked by playback/grace gate (NO WHISPER REQUEST WILL BE SENT)');
            return;
        }
        // Optional but super useful: confirm we’re actually about to send
        log_1.log.info({
            event: 'stt_enqueue_start',
            kind: meta.reason,
            payload_bytes: payloadPcm16.length,
            ...(this.logContext ?? {}),
        }, 'stt enqueue starting transcription');
        if (meta.reason === 'final' && meta.finalReason === 'stop') {
            this.finalizingStop = true;
            this.finalizingStopAtMs = this.nowMs();
            this.finalizingStopSpeechStreak = 0;
            this.finalizingStopIgnoreCount = 0;
            log_1.log.info({
                event: 'stt_finalizing_stop_armed',
                ts: this.finalizingStopAtMs,
                ...(this.logContext ?? {}),
            }, 'finalizing stop armed');
        }
        this.inFlight = true;
        this.inFlightKind = meta.reason;
        const token = (this.inFlightToken += 1);
        this.inFlightAbort = new AbortController();
        if (meta.isFinal)
            this.finalizeToResultTimer = (0, metrics_1.startStageTimer)('stt_finalize_to_result_ms', this.tenantLabel);
        // notify CallSession if wired
        this.onSttRequestStart?.(meta.reason);
        void this.transcribePayload(payloadPcm16, meta, token, this.inFlightAbort.signal)
            .catch((err) => log_1.log.error({ event: 'stt_transcribePayload_failed', err, ...(this.logContext ?? {}) }, 'stt transcription failed'))
            .finally(() => {
            if (this.inFlightToken !== token)
                return;
            const kind = this.inFlightKind ?? meta.reason;
            this.inFlight = false;
            this.inFlightKind = undefined;
            this.inFlightAbort = undefined;
            this.finalizeToResultTimer = undefined;
            if (kind === 'final') {
                this.finalizingStop = false;
                this.finalizingStopAtMs = 0;
                this.finalizingStopSpeechStreak = 0;
                this.finalizingStopIgnoreCount = 0;
            }
            this.onSttRequestEnd?.(kind);
        });
    }
    async transcribePayload(payloadPcm16, meta, token, signal) {
        // ✅ NEW: last safety net before calling provider
        this.handlePlaybackTransitionIfNeeded();
        if (this.playbackGateActive())
            return;
        // ✅ CALL LIFECYCLE GATE: do not call provider if call is ended/inactive
        if (this.isCallActive && !this.isCallActive()) {
            if (!this.allowFinalDuringCallEndDrain(meta.reason))
                return;
        }
        // ✅ Abort hygiene: never proceed if the signal is already aborted
        if (signal.aborted)
            return;
        const startedAt = this.nowMs();
        const audioInput = {
            audio: payloadPcm16,
            sampleRateHz: this.sampleRate,
            encoding: 'pcm16le',
            channels: 1,
        };
        const endStt = (0, metrics_1.startStageTimer)('stt', this.tenantLabel);
        try {
            const result = await this.provider.transcribe(audioInput, {
                language: this.language,
                isPartial: meta.reason === 'partial',
                endpointUrl: this.whisperUrl,
                logContext: this.logContext,
                signal,
            });
            endStt();
            if (token !== this.inFlightToken)
                return;
            this.finalizeToResultTimer?.();
            this.finalizeToResultTimer = undefined;
            const text = normalizeWhitespace(result.text ?? '');
            log_1.log.info({
                event: 'stt_transcription_result',
                kind: meta.reason,
                elapsed_ms: this.nowMs() - startedAt,
                text_len: text.length,
                ...(this.logContext ?? {}),
            }, 'stt transcription result');
            // Tier 5: report final result for per-call metrics (including empty)
            if (meta.reason === 'final') {
                const utteranceMs = Math.round((payloadPcm16.length / this.bytesPerSecondPcm16) * 1000);
                this.onFinalResult?.({
                    isEmpty: text.length === 0,
                    textLength: text.length,
                    utteranceMs,
                });
            }
            if (!text)
                return;
            if (meta.reason === 'partial') {
                if (text === this.lastPartialTranscript)
                    return;
                this.lastPartialTranscript = text;
                if (isNonEmpty(text))
                    this.onTranscript(text, 'partial_fallback');
                return;
            }
            if (!this.finalTranscriptAccepted) {
                this.finalTranscriptAccepted = true;
                this.onTranscript(text, 'final');
            }
        }
        catch (error) {
            endStt();
            if (signal.aborted || isAbortError(error))
                return;
            (0, metrics_1.incStageError)('stt', this.tenantLabel);
            throw error;
        }
    }
    updateRollingStats(stats) {
        const alpha = 0.1;
        this.rollingRms = this.rollingRms === 0 ? stats.rms : this.rollingRms * (1 - alpha) + stats.rms * alpha;
        this.rollingPeak = this.rollingPeak === 0 ? stats.peak : this.rollingPeak * (1 - alpha) + stats.peak * alpha;
    }
    /** Tier 5: Effective RMS floor (noise-adaptive or fixed). */
    getEffectiveRmsFloor() {
        if (!T5_NOISE_FLOOR_ENABLED ||
            this.noiseFloorSampleCount < T5_NOISE_FLOOR_MIN_SAMPLES ||
            this.noiseFloorRms <= 0) {
            return this.speechRmsFloor;
        }
        const adaptive = this.noiseFloorRms * T5_ADAPTIVE_RMS_MULT;
        return Math.max(T5_ADAPTIVE_MIN_RMS, this.speechRmsFloor, adaptive);
    }
    /** Tier 5: Effective peak floor (noise-adaptive or fixed). */
    getEffectivePeakFloor() {
        if (!T5_NOISE_FLOOR_ENABLED ||
            this.noiseFloorSampleCount < T5_NOISE_FLOOR_MIN_SAMPLES ||
            this.noiseFloorPeak <= 0) {
            return this.speechPeakFloor;
        }
        const adaptive = this.noiseFloorPeak * T5_ADAPTIVE_PEAK_MULT;
        return Math.max(T5_ADAPTIVE_MIN_PEAK, this.speechPeakFloor, adaptive);
    }
    resolveGateClosedReason(gateRms, gatePeak, streak) {
        if (!gateRms)
            return 'below_rms_floor';
        if (!gatePeak)
            return 'below_peak_floor';
        if (streak < this.speechFramesRequired)
            return 'insufficient_frames';
        return null;
    }
    maybeLogGateClosed(reason, stats, frameMs) {
        const now = this.nowMs();
        if (now - this.lastGateLogAtMs < 1000)
            return;
        this.lastGateLogAtMs = now;
        const playbackActive = this.isPlaybackActive?.();
        const listening = this.isListening?.();
        const codec = this.getCodec?.() ?? this.inputCodec;
        const track = this.getTrack?.();
        log_1.log.info({
            event: 'stt_gate_closed',
            reason,
            codec,
            track,
            playback_active: playbackActive,
            listening,
            rms: stats.rms,
            peak: stats.peak,
            rolling_rms: this.rollingRms,
            rolling_peak: this.rollingPeak,
            rms_floor: this.speechRmsFloor,
            peak_floor: this.speechPeakFloor,
            speech_frames_required: this.speechFramesRequired,
            speech_frame_streak: this.speechFrameStreak,
            frame_ms: Math.round(frameMs),
            sample_rate_hz: this.sampleRate,
            disable_gates: this.disableGates,
            ...(this.logContext ?? {}),
        }, 'stt gate closed');
    }
    resetUtteranceState() {
        this.inSpeech = false;
        this.speechStartAtMs = 0; // Tier 5: late-final watchdog
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.sawSpeech = false;
        this.lastPrependedMs = 0;
        this.utteranceFrames = [];
        this.speechFrameStreak = 0;
        this.playbackSpeechStreak = 0;
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.lastPartialTranscript = '';
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.lastSpeechAt = 0;
        this.vadSpeechStreak = 0;
        this.vadSilenceStreak = 0;
        if (this.vad)
            this.vad.reset();
    }
}
exports.ChunkedSTT = ChunkedSTT;
//# sourceMappingURL=chunkedSTT.js.map