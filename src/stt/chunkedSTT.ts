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

import crypto from 'crypto';
import { env } from '../env';
import { log } from '../log';
import { incStageError, observeStageDuration, startStageTimer } from '../metrics';
import { SileroVad } from './vad/sileroVad';

type FinalReason = 'silence' | 'stop' | 'max';
type TranscriptSource = 'partial_fallback' | 'final';

export interface SpeechStartInfo {
  rms: number;
  peak: number;
  frameMs: number;
  streak: number;
}

// ChunkedSTT sends PCM16LE to provider.
// Provider handles WAV wrapping / HTTP / streaming / etc.
export type STTProviderId = 'http_pcm16';

export type STTAudioInput = {
  audio: Buffer; // PCM16LE mono
  sampleRateHz: number;
  encoding: 'pcm16le';
  channels: 1;
};

export interface STTProvider {
  id: STTProviderId;
  transcribe(
    input: STTAudioInput,
    opts: {
      language?: string;
      isPartial: boolean;
      endpointUrl: string;
      logContext?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<{ text: string }>;
}

export interface ChunkedSTTOptions {
  provider: STTProvider;
  whisperUrl: string;
  language?: string;
  logContext?: Record<string, unknown>;

  onTranscript: (text: string, source?: TranscriptSource) => void;
  onSpeechStart?: (info: SpeechStartInfo) => void;

  // Optional lifecycle hooks (used by CallSession to suppress dead-air while STT in-flight)
  onSttRequestStart?: (kind: 'partial' | 'final') => void;
  onSttRequestEnd?: (kind: 'partial' | 'final') => void;

  // Optional runtime state hooks (used for logging / safety gates)
  isPlaybackActive?: () => boolean;
  isListening?: () => boolean;
  getTrack?: () => string | undefined;
  getCodec?: () => string | undefined;

  // Input coming into ingest()
  inputCodec?: 'pcmu' | 'pcm16le';
  sampleRate?: number; // if inputCodec=pcmu default 8000; if pcm16le default 16000
  frameMs?: number;

  // Allow opts override (if omitted, env takes precedence)
  disableGates?: boolean;

  partialIntervalMs?: number;
  preRollMs?: number;
  silenceEndMs?: number;
  maxUtteranceMs?: number;

  speechRmsFloor?: number;
  speechPeakFloor?: number;
  speechFramesRequired?: number;
}

const DEFAULT_PARTIAL_INTERVAL_MS = 250;
const DEFAULT_SILENCE_END_MS = 900;
const DEFAULT_PRE_ROLL_MS = 300;
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

function parseBool(value: string | undefined, def = false): boolean {
  if (value == null) return def;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function safeNum(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const v = Number(value.trim());
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isNonEmpty(text: string): boolean {
  return normalizeWhitespace(text).length > 0;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError';
}

function computeRmsAndPeak(pcm16le: Buffer): { rms: number; peak: number } {
  if (pcm16le.length < 2) return { rms: 0, peak: 0 };
  const samples = Math.floor(pcm16le.length / 2);
  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < samples; i += 1) {
    const s = pcm16le.readInt16LE(i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSquares += s * s;
  }

  return { rms: Math.sqrt(sumSquares / samples), peak };
}

function clampInt16(n: number): number {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
}

// PCMU -> PCM16LE decoding (kept here only because ingest() receives PCMU in some transports).
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

function pcmuToPcm16le(pcmu: Buffer): Buffer {
  const output = Buffer.alloc(pcmu.length * 2);
  for (let i = 0; i < pcmu.length; i += 1) {
    const sample = muLawToPcmSample(pcmu[i]!);
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

function upsamplePcm16le8kTo16kLinear(pcm16le: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16le.length / 2);
  if (sampleCount === 0) return Buffer.alloc(0);

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

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export class ChunkedSTT {
  // ===== Optional VAD (Silero ONNX) =====
  private readonly vadEnabled: boolean;
  private readonly vadThreshold: number;
  private vad?: SileroVad;
  private vadReady = false;

  // VAD smoothing counters (optional but helps avoid flapping)
  private vadSpeechStreak = 0;
  private vadSilenceStreak = 0;
  private vadSpeechNow = false;

  // VAD hysteresis thresholds (prevents flapping)
  private readonly vadSpeechFramesRequired = clamp(safeNum(process.env.STT_VAD_SPEECH_FRAMES_REQUIRED, 2), 1, 20);
  private readonly vadSilenceFramesRequired = clamp(safeNum(process.env.STT_VAD_SILENCE_FRAMES_REQUIRED, 6), 1, 50);

  private readonly provider: STTProvider;
  private readonly whisperUrl: string;
  private readonly language?: string;
  private readonly logContext?: Record<string, unknown>;
  private readonly tenantLabel: string;

  private readonly inputCodec: 'pcmu' | 'pcm16le';
  private readonly sampleRate: number; // expected input sample rate
  private readonly bytesPerSecondPcm16: number;

  private readonly fallbackFrameMs: number;

  private readonly minSpeechMs: number;
  private readonly silenceMinSeconds: number;
  private readonly finalTailCushionMs: number;
  private readonly finalMinBytes: number;
  private readonly partialMinMs: number;
  private readonly partialMinBytes: number;

  private readonly partialIntervalMs: number;
  private readonly preRollMaxMs: number;
  private readonly silenceEndMs: number;
  private readonly maxUtteranceMs: number;

  private readonly speechRmsFloor: number;
  private readonly speechPeakFloor: number;
  private readonly speechFramesRequired: number;
  private readonly disableGates: boolean;

  private readonly onTranscript: (text: string, source?: TranscriptSource) => void;
  private readonly onSpeechStart?: (info: SpeechStartInfo) => void;

  private readonly onSttRequestStart?: (kind: 'partial' | 'final') => void;
  private readonly onSttRequestEnd?: (kind: 'partial' | 'final') => void;

  private readonly isPlaybackActive?: () => boolean;
  private readonly isListening?: () => boolean;
  private readonly getTrack?: () => string | undefined;
  private readonly getCodec?: () => string | undefined;

  private timer: NodeJS.Timeout | undefined;

  // State
  private firstFrameLogged = false;

  private inSpeech = false;
  private lastSpeechAt = 0;

  private utteranceMs = 0;
  private utteranceBytes = 0;

  private preRollFrames: Array<{ buffer: Buffer; ms: number }> = [];
  private preRollMs = 0;

  private utteranceFrames: Array<{ buffer: Buffer; ms: number }> = [];

  private speechFrameStreak = 0;
  private playbackSpeechStreak = 0;

  private silenceFrameStreak = 0;
  private silenceToFinalizeTimer?: () => void;

  private lastPartialAt = 0;
  private lastPartialTranscript = '';

  private rollingRms = 0;
  private rollingPeak = 0;
  private lastGateLogAtMs = 0;

  private finalFlushAt = 0;
  private finalTranscriptAccepted = false;
  private finalizeToResultTimer?: () => void;

  private inFlight = false;
  private inFlightKind?: 'partial' | 'final';
  private inFlightAbort?: AbortController;
  private inFlightToken = 0;

  // ===== Optional RX replay guard (ENV-gated) =====
  private readonly rxGuardEnabled: boolean;
  private readonly rxDedupeWindow: number;
  private readonly recentRxHashes: string[] = [];
  private rxFramesDropped = 0;
  private rxFramesKept = 0;

  // ===== Playback hard-gate state =====
  private playbackWasActive = false;
  private playbackEndedAtMs = 0;
  private readonly postPlaybackGraceMs = safeNum(process.env.STT_POST_PLAYBACK_GRACE_MS, 650);

  public constructor(opts: ChunkedSTTOptions) {
    this.provider = opts.provider;
    this.whisperUrl = opts.whisperUrl;
    this.language = opts.language;
    this.logContext = opts.logContext;
    this.tenantLabel = (opts.logContext?.tenant_id as string) ?? 'unknown';

    this.onTranscript = opts.onTranscript;
    this.onSpeechStart = opts.onSpeechStart;

    this.onSttRequestStart = opts.onSttRequestStart;
    this.onSttRequestEnd = opts.onSttRequestEnd;

    this.isPlaybackActive = opts.isPlaybackActive;
    this.isListening = opts.isListening;
    this.getTrack = opts.getTrack;
    this.getCodec = opts.getCodec;

    this.inputCodec = opts.inputCodec ?? 'pcmu';

    const defaultHz = this.inputCodec === 'pcm16le' ? 16000 : 8000;
    const sampleRate = safeNum(opts.sampleRate, defaultHz);
    this.sampleRate = sampleRate > 0 ? sampleRate : defaultHz;

    // PCM16LE bytes/sec (mono)
    this.bytesPerSecondPcm16 = this.sampleRate * 2;

    this.fallbackFrameMs = safeNum(opts.frameMs, env.STT_CHUNK_MS);

    const minSeconds = safeNum(env.STT_MIN_SECONDS, DEFAULT_MIN_SECONDS);
    this.minSpeechMs = Math.max(0, minSeconds) * 1000;

    const silenceMinSeconds = safeNum(env.STT_SILENCE_MIN_SECONDS, DEFAULT_SILENCE_MIN_SECONDS);
    this.silenceMinSeconds = silenceMinSeconds > 0 ? silenceMinSeconds : DEFAULT_SILENCE_MIN_SECONDS;

    const finalTailCushionMs = safeNum(env.FINAL_TAIL_CUSHION_MS, DEFAULT_FINAL_TAIL_CUSHION_MS);
    this.finalTailCushionMs = clamp(finalTailCushionMs, 0, 2000);

    const finalMinSeconds = safeNum(env.FINAL_MIN_SECONDS, DEFAULT_FINAL_MIN_SECONDS);
    const computedFinalMinBytes = Math.round(this.bytesPerSecondPcm16 * Math.max(0, finalMinSeconds));
    const finalMinBytes = safeNum(env.FINAL_MIN_BYTES, computedFinalMinBytes);
    this.finalMinBytes = Math.max(0, Math.round(finalMinBytes ?? DEFAULT_FINAL_MIN_BYTES_FALLBACK));

    this.partialMinMs = clamp(safeNum(env.STT_PARTIAL_MIN_MS, DEFAULT_PARTIAL_MIN_MS), 200, 5000);
    this.partialMinBytes = Math.max(0, Math.round((this.bytesPerSecondPcm16 * this.partialMinMs) / 1000));

    this.partialIntervalMs = clamp(
      safeNum(opts.partialIntervalMs, env.STT_PARTIAL_INTERVAL_MS ?? DEFAULT_PARTIAL_INTERVAL_MS),
      100,
      10000,
    );

    this.preRollMaxMs = clamp(safeNum(opts.preRollMs, env.STT_PRE_ROLL_MS ?? DEFAULT_PRE_ROLL_MS), 0, 2000);
    this.silenceEndMs = clamp(
      safeNum(opts.silenceEndMs, env.STT_SILENCE_END_MS ?? DEFAULT_SILENCE_END_MS),
      100,
      8000,
    );
    this.maxUtteranceMs = clamp(
      safeNum(opts.maxUtteranceMs, env.STT_MAX_UTTERANCE_MS ?? DEFAULT_MAX_UTTERANCE_MS),
      2000,
      60000,
    );

    const rmsFloorEnv = env.STT_RMS_FLOOR ?? env.STT_SPEECH_RMS_FLOOR ?? DEFAULT_SPEECH_RMS_FLOOR;
    const peakFloorEnv = env.STT_PEAK_FLOOR ?? env.STT_SPEECH_PEAK_FLOOR ?? DEFAULT_SPEECH_PEAK_FLOOR;
    this.speechRmsFloor = safeNum(opts.speechRmsFloor, rmsFloorEnv);
    this.speechPeakFloor = safeNum(opts.speechPeakFloor, peakFloorEnv);

    this.speechFramesRequired = clamp(
      safeNum(opts.speechFramesRequired, env.STT_SPEECH_FRAMES_REQUIRED ?? DEFAULT_SPEECH_FRAMES_REQUIRED),
      1,
      30,
    );

    // honor opts override
    this.disableGates = opts.disableGates ?? (env.STT_DISABLE_GATES ?? false);
    this.vadEnabled = parseBool(process.env.STT_VAD_ENABLED, false);
    this.vadThreshold = safeNum(process.env.STT_VAD_THRESHOLD, 0.5);

    if (this.vadEnabled) {
      void SileroVad.create({ threshold: this.vadThreshold })
        .then((v) => {
          this.vad = v;
          log.info(
            { event: 'stt_vad_ready', threshold: this.vadThreshold, ...(this.logContext ?? {}) },
            'silero vad ready',
          );
          this.vadReady = true;
        })
        .catch((err) => {
          log.error({ event: 'stt_vad_init_failed', err, ...(this.logContext ?? {}) }, 'silero vad init failed');
        })
        .then(() => undefined);
    }

    // Optional RX replay guard
    this.rxGuardEnabled = parseBool(process.env.STT_RX_POSTPROCESS_ENABLED, false);
    const win = Number.parseInt(process.env.STT_RX_DEDUPE_WINDOW ?? '', 10);
    this.rxDedupeWindow =
      this.rxGuardEnabled && Number.isFinite(win) && win > 0 ? win : this.rxGuardEnabled ? DEFAULT_RX_DEDUPE_WINDOW : 0;

    log.info(
      {
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
        },
        ...(this.logContext ?? {}),
      },
      'stt tuning',
    );

    // Partial tick only. Finalization happens on silence/max/stop.
    this.timer = setInterval(() => {
      try {
        this.flushIfReady('interval');
      } catch (err) {
        log.error({ err, ...(this.logContext ?? {}) }, 'stt interval flush failed');
      }
    }, this.partialIntervalMs);
  }

  // Direct PCM16 ingest (already decoded elsewhere).
  public ingestPcm16(pcm16: Int16Array, sampleRateHz: number): void {
    if (!pcm16 || pcm16.length === 0) return;

    if (sampleRateHz !== this.sampleRate) {
      log.warn(
        {
          event: 'chunked_stt_sample_rate_mismatch',
          expected_hz: this.sampleRate,
          got_hz: sampleRateHz,
          ...(this.logContext ?? {}),
        },
        'chunked stt sample rate mismatch',
      );
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
      log.info(
        {
          event: 'stt_first_pcm16_frame',
          input_codec: 'pcm16le',
          int16_len: pcm16.length,
          input_bytes: frame.length,
          sample_rate_hz: sampleRateHz,
          computed_frame_ms: Math.round(frameMs),
          ...(this.logContext ?? {}),
        },
        'stt first pcm16 frame',
      );
    }

    void this.ingestDecodedPcm16(frame, frameMs);
  }

  // Unified ingest for either PCMU or PCM16LE input.
  public ingest(input: Buffer): void {
    if (!input || input.length === 0) return;

    const bytesPerSampleIn = this.inputCodec === 'pcmu' ? 1 : 2;
    const samples = input.length / bytesPerSampleIn;
    const computedFrameMs = (samples / this.sampleRate) * 1000;
    const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0 ? computedFrameMs : this.fallbackFrameMs;

    if (!this.firstFrameLogged) {
      this.firstFrameLogged = true;

      const computedSamples = input.length / bytesPerSampleIn;

      log.info(
        {
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
        },
        'stt first audio frame',
      );
    }

    let framePcm16: Buffer;
    if (this.inputCodec === 'pcmu') {
      framePcm16 = pcmuToPcm16le(input);
    } else {
      // passthrough, but COPY so we don't retain a pooled/reused buffer
      framePcm16 = Buffer.from(input);
    }

    void this.ingestDecodedPcm16(framePcm16, frameMs);
  }

  private nowMs(): number {
    return Date.now();
  }

  private playbackGateActive(): boolean {
    if (this.disableGates) return false;

    const active = !!this.isPlaybackActive?.();
    if (active) return true;

    if (this.playbackEndedAtMs > 0) {
      const since = this.nowMs() - this.playbackEndedAtMs;
      if (since >= 0 && since < this.postPlaybackGraceMs) return true;
    }

    return false;
  }

  private handlePlaybackTransitionIfNeeded(): void {
    if (this.disableGates) return;

    const active = !!this.isPlaybackActive?.();

    if (active) {
      // Playback is active now: abort any in-flight STT and reset utterance state to avoid mixing.
      if (!this.playbackWasActive) {
        this.playbackWasActive = true;

        if (this.inFlight) {
          this.abortInFlight('finalize');
        }

        if (this.inSpeech) {
          this.resetUtteranceState();
        }
      }
      return;
    }

    if (this.playbackWasActive) {
      // Playback just ended
      this.playbackWasActive = false;
      this.playbackEndedAtMs = this.nowMs();
      this.playbackSpeechStreak = 0;


      // reset VAD state so we don't carry stale speech state across the boundary
      this.vadSpeechNow = false;
      this.vadSpeechStreak = 0;
      this.vadSilenceStreak = 0;
      if (this.vad) this.vad.reset();

      // if we have RX dedupe, clear it across boundary
      this.recentRxHashes.length = 0;
    }
  }

  // Optional defensive replay guard: drops identical frames repeated within last N frames.
  private shouldDropRxFrame(pcm16: Buffer): { drop: boolean; sha1_10: string; matchedLag?: number } {
    if (!this.rxGuardEnabled || this.rxDedupeWindow <= 0) return { drop: false, sha1_10: '' };

    const h = sha1Hex(pcm16);
    const h10 = h.slice(0, 10);

    const recent = this.recentRxHashes;
    for (let i = recent.length - 1, lag = 1; i >= 0 && lag <= this.rxDedupeWindow; i -= 1, lag += 1) {
      if (recent[i] === h) return { drop: true, sha1_10: h10, matchedLag: lag };
    }

    recent.push(h);
    if (recent.length > this.rxDedupeWindow) recent.shift();
    return { drop: false, sha1_10: h10 };
  }

  // Post-decode path (PCM16LE mono @ this.sampleRate)
  private async ingestDecodedPcm16(pcm16: Buffer, frameMs: number): Promise<void> {
    // Detect playback transitions & enforce boundary resets.
    this.handlePlaybackTransitionIfNeeded();

    // ===== HARD GATE during playback (and brief grace after) =====
    // IMPORTANT: We still run VAD/speech detection during playback so barge-in works.
    // We only block *buffering/transcription* during playback/grace.
    const gatedForPlayback = this.playbackGateActive();


    // Once grace has elapsed, clear the marker.
    if (!this.disableGates && this.playbackEndedAtMs > 0) {
      const since = this.nowMs() - this.playbackEndedAtMs;
      if (since >= this.postPlaybackGraceMs) this.playbackEndedAtMs = 0;
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
            log.warn(
              {
                event: 'stt_rx_replay_dropped',
                matched_lag: guard.matchedLag,
                sha1_10: guard.sha1_10,
                dropped: this.rxFramesDropped,
                kept: this.rxFramesKept,
                rx_dedupe_window: this.rxDedupeWindow,
                ...(this.logContext ?? {}),
              },
              'dropping replayed PCM frame before ChunkedSTT buffering',
            );
          }

          return; // critical: do NOT continue into VAD/buffering
        }

        // Guard enabled and frame not dropped
        this.rxFramesKept += 1;
      } else {
        // Guard disabled: still advance for log throttling / observability
        this.rxFramesKept += 1;
      }
    }


    const stats = computeRmsAndPeak(pcm16);
    this.updateRollingStats(stats);

    const gateRms = stats.rms >= this.speechRmsFloor;
    const gatePeak = stats.peak >= this.speechPeakFloor;

    // === VAD: speech decision ===
    if (this.vadEnabled && this.vadReady && this.vad) {
      const pcmForVad =
        this.sampleRate === 16000
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
          } else {
            this.vadSilenceStreak += 1;
            this.vadSpeechStreak = 0;
          }
        }
      }
    }

    let vadSpeechDecision: boolean | null = null;
    if (this.vadEnabled && this.vadReady && this.vad) {
      if (this.vadSpeechStreak >= this.vadSpeechFramesRequired) vadSpeechDecision = true;
      else if (this.vadSilenceStreak >= this.vadSilenceFramesRequired) vadSpeechDecision = false;
      else vadSpeechDecision = this.vadSpeechNow;
    }

    const isSpeech = this.disableGates ? true : (vadSpeechDecision ?? (gateRms && gatePeak));
    // If we're in playback/grace, allow barge-in detection but do not buffer/transcribe.
    if (gatedForPlayback) {
      if (isSpeech) {
        this.playbackSpeechStreak += 1;

        if (this.playbackSpeechStreak >= this.speechFramesRequired) {
          this.onSpeechStart?.({
            rms: stats.rms,
            peak: stats.peak,
            frameMs,
            streak: this.playbackSpeechStreak,
          });

          // Reset so we don't spam onSpeechStart repeatedly.
          this.playbackSpeechStreak = 0;
        }
      } else {
        this.playbackSpeechStreak = 0;
      }

      // Do not buffer any frames or build utterances during playback/grace.
      return;
    }



    if (!this.disableGates && (this.rxFramesKept <= 20 || this.rxFramesKept % 100 === 0)) {
      log.info(
        {
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
        },
        'stt speech decision',
      );
    }

    // Barge-in: if final request is in-flight and speech resumes, abort and reset.
    if (this.inFlight && this.inFlightKind === 'final' && isSpeech) {
      this.abortInFlight('barge_in');
      this.resetUtteranceState();
      return;
    }

    // Not in speech yet: build pre-roll and detect start
    if (!this.inSpeech) {
      this.addPreRollFrame(pcm16, frameMs);

      if (isSpeech) {
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.speechFrameStreak += 1;
      } else {
        this.speechFrameStreak = 0;
      }

      if (isSpeech && this.speechFrameStreak >= this.speechFramesRequired) {
        this.startSpeech(stats, frameMs);
        this.onSpeechStart?.({ rms: stats.rms, peak: stats.peak, frameMs, streak: this.speechFrameStreak });
      } else if (!this.disableGates) {
        const reason = this.resolveGateClosedReason(gateRms, gatePeak, this.speechFrameStreak);
        if (reason) this.maybeLogGateClosed(reason, stats, frameMs);
      }
      return;
    }

    // In speech: append frames and decide when to finalize
    this.appendUtterance(pcm16, frameMs);

    if (isSpeech) {
      this.lastSpeechAt = this.nowMs();
      this.silenceFrameStreak = 0;
      this.silenceToFinalizeTimer = undefined;
    } else {
      if (this.silenceFrameStreak === 0) {
        this.silenceToFinalizeTimer = startStageTimer('stt_silence_to_finalize_ms', this.tenantLabel);
      }
      this.silenceFrameStreak += 1;

      const silenceFramesNeeded = Math.max(1, Math.ceil(this.silenceEndMs / frameMs));
      if (this.silenceFrameStreak >= silenceFramesNeeded) {
        this.silenceToFinalizeTimer?.();
        this.silenceToFinalizeTimer = undefined;
        this.finalizeUtterance('silence');
        return;
      }
    }

    if (this.utteranceMs >= this.maxUtteranceMs) {
      this.finalizeUtterance('max');
      return;
    }
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inSpeech && this.utteranceBytes > 0) this.flushIfReady('stop');
  }

  private flushIfReady(reason: 'interval' | 'silence' | 'stop'): void {
    if (reason === 'interval') return void this.maybeSendPartial();
    if (reason === 'stop') return void this.finalizeUtterance('stop');
    this.finalizeUtterance('silence');
  }

  private addPreRollFrame(pcm16: Buffer, frameMs: number): void {
    if (this.preRollMaxMs <= 0) return;

    const snap = Buffer.from(pcm16);

    this.preRollFrames.push({ buffer: snap, ms: frameMs });
    this.preRollMs += frameMs;

    while (this.preRollMs > this.preRollMaxMs && this.preRollFrames.length > 0) {
      const dropped = this.preRollFrames.shift();
      if (!dropped) break;
      this.preRollMs -= dropped.ms;
    }
  }

  private startSpeech(stats: { rms: number; peak: number }, frameMs: number): void {
    this.inSpeech = true;
    this.lastSpeechAt = this.nowMs();
    this.silenceFrameStreak = 0;
    this.silenceToFinalizeTimer = undefined;

    this.utteranceFrames = [...this.preRollFrames];
    this.utteranceMs = this.preRollMs;
    this.utteranceBytes = this.utteranceFrames.reduce((sum, f) => sum + f.buffer.length, 0);

    this.preRollFrames = [];
    this.preRollMs = 0;

    this.lastPartialAt = 0;
    this.lastPartialTranscript = '';

    this.finalFlushAt = 0;
    this.finalTranscriptAccepted = false;

    log.info(
      {
        event: 'stt_speech_start',
        speech_rms: Number(stats.rms.toFixed(4)),
        speech_peak: Number(stats.peak.toFixed(4)),
        frame_ms: Math.round(frameMs),
        ...(this.logContext ?? {}),
      },
      'stt speech start',
    );
  }

  private appendUtterance(pcm16: Buffer, frameMs: number): void {
    const snap = Buffer.from(pcm16);
    this.utteranceFrames.push({ buffer: snap, ms: frameMs });
    this.utteranceMs += frameMs;
    this.utteranceBytes += snap.length;
  }

  private trimTrailingSilence(frames: Array<{ buffer: Buffer; ms: number }>): Array<{ buffer: Buffer; ms: number }> {
    if (frames.length === 0) return frames;

    let lastSpeechIndex = -1;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const stats = computeRmsAndPeak(frames[i]!.buffer);
      if (stats.rms >= this.speechRmsFloor && stats.peak >= this.speechPeakFloor) {
        lastSpeechIndex = i;
        break;
      }
    }
    if (lastSpeechIndex === -1) return frames;

    let endIndex = lastSpeechIndex;
    let tailMs = 0;
    for (let i = lastSpeechIndex + 1; i < frames.length; i += 1) {
      tailMs += frames[i]!.ms;
      endIndex = i;
      if (tailMs >= this.finalTailCushionMs) break;
    }

    if (endIndex >= frames.length - 1) return frames;
    return frames.slice(0, endIndex + 1);
  }

  private maybeSendPartial(): void {
    if (!this.inSpeech) return;
    if (this.inFlight) return;

    // ✅ NEW: never send partials during playback/grace
    this.handlePlaybackTransitionIfNeeded();

    if (this.playbackGateActive()) return;

    if (this.utteranceMs < this.minSpeechMs) return;

    const now = this.nowMs();
    if (this.lastPartialAt > 0 && now - this.lastPartialAt < this.partialIntervalMs) return;

    const payload = this.concatFrames(this.utteranceFrames);
    if (payload.length < this.partialMinBytes) return;

    this.lastPartialAt = now;
    this.enqueueTranscription(payload, { reason: 'partial', isFinal: false });
  }

  private finalizeUtterance(reason: FinalReason): void {
    if (!this.inSpeech || this.utteranceBytes === 0) return;

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
        observeStageDuration('pre_stt_gate', this.tenantLabel, this.nowMs() - this.lastSpeechAt);
      }
    }

    if (this.inFlight) {
      if (this.inFlightKind === 'final') return;
      this.abortInFlight('finalize');
    }

    const trimmedFrames = this.trimTrailingSilence(this.utteranceFrames);
    const payload = this.concatFrames(trimmedFrames);

    log.info(
      {
        event: 'stt_finalize_payload_stats',
        reason,
        frames: trimmedFrames.length,
        utterance_ms: Math.round((payload.length / this.bytesPerSecondPcm16) * 1000),
        bytes: payload.length,
        silence_end_ms: this.silenceEndMs,
        min_speech_ms: this.minSpeechMs,
        final_min_bytes: this.finalMinBytes,
        ...(this.logContext ?? {}),
      },
      'finalizing utterance payload',
    );

    this.enqueueTranscription(payload, {
      reason: 'final',
      isFinal: true,
      finalReason: reason,
    });

    this.resetUtteranceState();
  }

  private concatFrames(frames: Array<{ buffer: Buffer }>): Buffer {
    if (frames.length === 1) return frames[0]!.buffer;
    return Buffer.concat(frames.map((f) => f.buffer));
  }

  private abortInFlight(reason: 'barge_in' | 'finalize'): void {
    if (!this.inFlight) return;

    this.inFlightAbort?.abort();
    this.inFlightAbort = undefined;

    this.inFlight = false;
    this.inFlightKind = undefined;
    this.finalizeToResultTimer = undefined;
    this.finalFlushAt = 0;
    this.inFlightToken += 1;

    if (reason === 'barge_in') {
      this.silenceFrameStreak = 0;
      this.silenceToFinalizeTimer = undefined;
    }
  }

  private enqueueTranscription(
    payloadPcm16: Buffer,
    meta: { reason: 'partial' | 'final'; isFinal: boolean; finalReason?: FinalReason },
  ): void {
    if (this.inFlight) return;

    // ✅ NEW: final safety net
    this.handlePlaybackTransitionIfNeeded();
    if (this.playbackGateActive()) return;

    this.inFlight = true;
    this.inFlightKind = meta.reason;
    const token = (this.inFlightToken += 1);
    this.inFlightAbort = new AbortController();

    if (meta.isFinal) this.finalizeToResultTimer = startStageTimer('stt_finalize_to_result_ms', this.tenantLabel);

    // notify CallSession if wired
    this.onSttRequestStart?.(meta.reason);

    void this.transcribePayload(payloadPcm16, meta, token, this.inFlightAbort.signal)
      .catch((err) => log.error({ err, ...(this.logContext ?? {}) }, 'stt transcription failed'))
      .finally(() => {
        if (this.inFlightToken !== token) return;

        const kind = this.inFlightKind ?? meta.reason;

        this.inFlight = false;
        this.inFlightKind = undefined;
        this.inFlightAbort = undefined;
        this.finalizeToResultTimer = undefined;

        this.onSttRequestEnd?.(kind);
      });
  }

  private async transcribePayload(
    payloadPcm16: Buffer,
    meta: { reason: 'partial' | 'final'; isFinal: boolean; finalReason?: FinalReason },
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    // ✅ NEW: last safety net before calling provider
    this.handlePlaybackTransitionIfNeeded();
    if (this.playbackGateActive()) return;

    const startedAt = this.nowMs();

    const audioInput: STTAudioInput = {
      audio: payloadPcm16,
      sampleRateHz: this.sampleRate,
      encoding: 'pcm16le',
      channels: 1,
    };

    const endStt = startStageTimer('stt', this.tenantLabel);

    try {
      const result = await this.provider.transcribe(audioInput, {
        language: this.language,
        isPartial: meta.reason === 'partial',
        endpointUrl: this.whisperUrl,
        logContext: this.logContext,
        signal,
      });

      endStt();
      if (token !== this.inFlightToken) return;

      this.finalizeToResultTimer?.();
      this.finalizeToResultTimer = undefined;

      const text = normalizeWhitespace(result.text ?? '');
      log.info(
        {
          event: 'stt_transcription_result',
          kind: meta.reason,
          elapsed_ms: this.nowMs() - startedAt,
          text_len: text.length,
          ...(this.logContext ?? {}),
        },
        'stt transcription result',
      );

      if (!text) return;

      if (meta.reason === 'partial') {
        if (text === this.lastPartialTranscript) return;
        this.lastPartialTranscript = text;
        if (isNonEmpty(text)) this.onTranscript(text, 'partial_fallback');
        return;
      }

      if (!this.finalTranscriptAccepted) {
        this.finalTranscriptAccepted = true;
        this.onTranscript(text, 'final');
      }
    } catch (error) {
      endStt();
      if (signal.aborted || isAbortError(error)) return;
      incStageError('stt', this.tenantLabel);
      throw error;
    }
  }

  private updateRollingStats(stats: { rms: number; peak: number }): void {
    const alpha = 0.1;
    this.rollingRms = this.rollingRms === 0 ? stats.rms : this.rollingRms * (1 - alpha) + stats.rms * alpha;
    this.rollingPeak = this.rollingPeak === 0 ? stats.peak : this.rollingPeak * (1 - alpha) + stats.peak * alpha;
  }

  private resolveGateClosedReason(
    gateRms: boolean,
    gatePeak: boolean,
    streak: number,
  ): 'below_rms_floor' | 'below_peak_floor' | 'insufficient_frames' | null {
    if (!gateRms) return 'below_rms_floor';
    if (!gatePeak) return 'below_peak_floor';
    if (streak < this.speechFramesRequired) return 'insufficient_frames';
    return null;
  }

  private maybeLogGateClosed(
    reason: 'below_rms_floor' | 'below_peak_floor' | 'insufficient_frames',
    stats: { rms: number; peak: number },
    frameMs: number,
  ): void {
    const now = this.nowMs();
    if (now - this.lastGateLogAtMs < 1000) return;
    this.lastGateLogAtMs = now;

    const playbackActive = this.isPlaybackActive?.();
    const listening = this.isListening?.();
    const codec = this.getCodec?.() ?? this.inputCodec;
    const track = this.getTrack?.();

    log.info(
      {
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
      },
      'stt gate closed',
    );
  }

  private resetUtteranceState(): void {
    this.inSpeech = false;
    this.utteranceMs = 0;
    this.utteranceBytes = 0;
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
    if (this.vad) this.vad.reset();
  }
}
