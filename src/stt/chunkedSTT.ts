import { env } from '../env';
import { log } from '../log';
import { incStageError, observeStageDuration, startStageTimer } from '../metrics';
import type { AudioMeta } from '../diagnostics/audioProbe';
import { appendLineage, attachAudioMeta, getAudioMeta, markAudioSpan, probePcm } from '../diagnostics/audioProbe'
import { postprocessPcm16 } from '../audio/postprocess';



type FinalReason = 'silence' | 'stop' | 'max';

type TranscriptSource = 'partial_fallback' | 'final';

export interface SpeechStartInfo {
  rms: number;
  peak: number;
  frameMs: number;
  streak: number;
}

export type STTProviderId = 'http_wav_json' | 'http_pcm16';

export type STTAudioInput =
  | {
      audio: Buffer;
      sampleRateHz: number;
      encoding: 'wav';
      channels: 1;
    }
  | {
      audio: Buffer;
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
      audioMeta?: AudioMeta;
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
  isPlaybackActive?: () => boolean;
  isListening?: () => boolean;
  getTrack?: () => string | undefined;
  getCodec?: () => string | undefined;
  inputCodec?: 'pcmu' | 'pcm16le';
  sampleRate?: number;
  frameMs?: number;
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
const DEFAULT_MIN_SECONDS = 0.6;
const DEFAULT_SILENCE_MIN_SECONDS = 0.45;
const DEFAULT_FINAL_TAIL_CUSHION_MS = 120;
const DEFAULT_FINAL_MIN_SECONDS = 1.0;
const DEFAULT_PARTIAL_MIN_MS = 600;
const DEFAULT_HIGHPASS_CUTOFF_HZ = 100;

// Speech detection defaults (your env.ts may override)
const DEFAULT_SPEECH_RMS_FLOOR = 0.03;
const DEFAULT_SPEECH_PEAK_FLOOR = 0.1;
const DEFAULT_SPEECH_FRAMES_REQUIRED = 8;

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

function parseBool(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}

function computeHighpassAlpha(sampleRateHz: number, cutoffHz: number): number {
  const safeSampleRate = sampleRateHz > 0 ? sampleRateHz : 8000;
  const safeCutoff = cutoffHz > 0 ? cutoffHz : DEFAULT_HIGHPASS_CUTOFF_HZ;
  const rc = 1 / (2 * Math.PI * safeCutoff);
  const dt = 1 / safeSampleRate;
  return rc / (rc + dt);
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

  for (let i = 0; i < samples; i++) {
    const s = pcm16le.readInt16LE(i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSquares += s * s;
  }

  const rms = Math.sqrt(sumSquares / samples);
  return { rms, peak };
}

function clampInt16(n: number): number {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
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

function pcmuToPcm16le(pcmu: Buffer): Buffer {
  const output = Buffer.alloc(pcmu.length * 2);
  for (let i = 0; i < pcmu.length; i += 1) {
    const sample = muLawToPcmSample(pcmu[i]);
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

export class ChunkedSTT {
  private readonly provider: STTProvider;
  private readonly whisperUrl: string;
  private readonly language?: string;
  private readonly logContext?: Record<string, unknown>;
  private readonly tenantLabel: string;
  private readonly inputCodec: 'pcmu' | 'pcm16le';
  private readonly sampleRate: number;
  private readonly bytesPerSecond: number;
  private readonly fallbackFrameMs: number;
  private readonly minSpeechMs: number;
  private readonly silenceMinSeconds: number;
  private readonly finalTailCushionMs: number;
  private readonly finalMinBytes: number;
  private readonly partialMinBytes: number;
  private readonly partialMinMs: number;
  private readonly highpassEnabled: boolean;
  private readonly highpassCutoffHz: number;
  private readonly highpassAlpha: number;

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
  private readonly isPlaybackActive?: () => boolean;
  private readonly isListening?: () => boolean;
  private readonly getTrack?: () => string | undefined;
  private readonly getCodec?: () => string | undefined;

  private timer: NodeJS.Timeout | undefined;

  // State
  private firstFrameLogged = false;
  private inSpeech = false;
  private speechMs = 0;

  /** updated continuously while speech is happening */
  private lastSpeechAt = 0;

  private silenceMsAccum = 0;

  private utteranceMs = 0;
  private utteranceBytes = 0;

  private preRollFrames: Array<{ buffer: Buffer; ms: number }> = [];
  private preRollMs = 0;

  private utteranceFrames: Array<{ buffer: Buffer; ms: number }> = [];
  private utteranceLineage: string[] = [];

  private speechFrameStreak = 0;
  private silenceFrameStreak = 0;
  private silenceToFinalizeTimer?: () => void;

  private lastPartialAt = 0;
  private lastPartialTranscript = '';
  private lastNonEmptyPartialAt = 0;

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
  private decodedProbeLogged = false;
  private hpfPrevX = 0;
  private hpfPrevY = 0;

  public constructor(opts: ChunkedSTTOptions) {
    this.provider = opts.provider;
    this.whisperUrl = opts.whisperUrl;
    this.language = opts.language;
    this.logContext = opts.logContext;
    this.tenantLabel = (opts.logContext?.tenant_id as string) ?? 'unknown';
    this.inputCodec = opts.inputCodec ?? 'pcmu';
    const sampleRate = safeNum(opts.sampleRate, 8000);
    this.sampleRate = sampleRate > 0 ? sampleRate : 8000;
    this.bytesPerSecond = this.sampleRate * 2;
    this.fallbackFrameMs = safeNum(opts.frameMs, env.STT_CHUNK_MS);
    const minSeconds = safeNum(env.STT_MIN_SECONDS, DEFAULT_MIN_SECONDS);
    this.minSpeechMs = Math.max(0, minSeconds) * 1000;
    const silenceMinSeconds = safeNum(env.STT_SILENCE_MIN_SECONDS, DEFAULT_SILENCE_MIN_SECONDS);
    this.silenceMinSeconds =
      silenceMinSeconds > 0 ? silenceMinSeconds : DEFAULT_SILENCE_MIN_SECONDS;
    const finalTailCushionMs = safeNum(env.FINAL_TAIL_CUSHION_MS, DEFAULT_FINAL_TAIL_CUSHION_MS);
    this.finalTailCushionMs = clamp(finalTailCushionMs, 0, 2000);
    const finalMinSeconds = safeNum(env.FINAL_MIN_SECONDS, DEFAULT_FINAL_MIN_SECONDS);
    const computedFinalMinBytes = Math.round(
      this.bytesPerSecond * Math.max(0, finalMinSeconds),
    );
    const finalMinBytes = safeNum(env.FINAL_MIN_BYTES, computedFinalMinBytes);
    this.finalMinBytes = Math.max(0, Math.round(finalMinBytes));
    this.partialMinMs = clamp(safeNum(env.STT_PARTIAL_MIN_MS, DEFAULT_PARTIAL_MIN_MS), 200, 5000);
    this.partialMinBytes = Math.max(0, Math.round((this.bytesPerSecond * this.partialMinMs) / 1000));

    this.onTranscript = opts.onTranscript;
    this.onSpeechStart = opts.onSpeechStart;
    this.isPlaybackActive = opts.isPlaybackActive;
    this.isListening = opts.isListening;
    this.getTrack = opts.getTrack;
    this.getCodec = opts.getCodec;

    this.partialIntervalMs = clamp(
      safeNum(opts.partialIntervalMs, env.STT_PARTIAL_INTERVAL_MS ?? DEFAULT_PARTIAL_INTERVAL_MS),
      100,
      10000,
    );

    this.preRollMaxMs = clamp(safeNum(opts.preRollMs, env.STT_PRE_ROLL_MS ?? DEFAULT_PRE_ROLL_MS), 0, 2000);

    this.silenceEndMs = clamp(safeNum(opts.silenceEndMs, env.STT_SILENCE_END_MS ?? DEFAULT_SILENCE_END_MS), 100, 8000);

    this.maxUtteranceMs = clamp(safeNum(opts.maxUtteranceMs, env.STT_MAX_UTTERANCE_MS ?? DEFAULT_MAX_UTTERANCE_MS), 2000, 60000);

    this.highpassEnabled = env.STT_HIGHPASS_ENABLED ?? true;
    this.highpassCutoffHz = clamp(
      safeNum(env.STT_HIGHPASS_CUTOFF_HZ, DEFAULT_HIGHPASS_CUTOFF_HZ),
      20,
      300,
    );
    this.highpassAlpha = computeHighpassAlpha(this.sampleRate, this.highpassCutoffHz);

    const rmsFloorEnv = env.STT_RMS_FLOOR ?? env.STT_SPEECH_RMS_FLOOR ?? DEFAULT_SPEECH_RMS_FLOOR;
    const peakFloorEnv = env.STT_PEAK_FLOOR ?? env.STT_SPEECH_PEAK_FLOOR ?? DEFAULT_SPEECH_PEAK_FLOOR;
    this.speechRmsFloor = safeNum(opts.speechRmsFloor, rmsFloorEnv);
    this.speechPeakFloor = safeNum(opts.speechPeakFloor, peakFloorEnv);
    this.speechFramesRequired = clamp(
      safeNum(
        opts.speechFramesRequired,
        env.STT_SPEECH_FRAMES_REQUIRED ?? DEFAULT_SPEECH_FRAMES_REQUIRED,
      ),
      1,
      30,
    );
    this.disableGates = env.STT_DISABLE_GATES ?? false;

    log.info(
      {
        event: 'stt_tuning',
        stt_tuning: {
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
          highpass_enabled: this.highpassEnabled,
          highpass_cutoff_hz: this.highpassCutoffHz,
          disable_gates: this.disableGates,
        },
        ...(this.logContext ?? {}),
      },
      'stt tuning',
    );

    this.timer = setInterval(() => {
      try {
        this.flushIfReady('interval');
      } catch (err) {
        log.error({ err, ...(this.logContext ?? {}) }, 'stt interval flush failed');
      }
    }, this.partialIntervalMs);
  }

  private buildAudioMeta(overrides: Partial<AudioMeta> = {}): AudioMeta {
    const callIdRaw = this.logContext?.call_control_id;
    const callId = typeof callIdRaw === 'string' ? callIdRaw : undefined;
    const tenantId = typeof this.logContext?.tenant_id === 'string' ? this.logContext.tenant_id : undefined;
    return {
      callId,
      tenantId,
      logContext: this.logContext,
      ...overrides,
    };
  }

  private mergeLineageFromBuffer(buffer: Buffer): void {
    const meta = getAudioMeta(buffer);
    if (!meta?.lineage) return;
    for (const entry of meta.lineage) {
      if (!this.utteranceLineage.includes(entry)) {
        this.utteranceLineage.push(entry);
      }
    }
  }

  private mergeLineageFromFrames(frames: Array<{ buffer: Buffer }>): void {
    for (const frame of frames) {
      this.mergeLineageFromBuffer(frame.buffer);
    }
  }

  private applyHighpassPcm16(pcm16le: Buffer): Buffer {
    if (!this.highpassEnabled || pcm16le.length < 2) {
      return pcm16le;
    }

    const out = Buffer.allocUnsafe(pcm16le.length);
    const samples = Math.floor(pcm16le.length / 2);
    let prevX = this.hpfPrevX;
    let prevY = this.hpfPrevY;
    const alpha = this.highpassAlpha;

    for (let i = 0; i < samples; i += 1) {
      const x = pcm16le.readInt16LE(i * 2) / 32768;
      const y = alpha * (prevY + x - prevX);
      prevX = x;
      prevY = y;
      out.writeInt16LE(clampInt16(Math.round(y * 32767)), i * 2);
    }

    this.hpfPrevX = prevX;
    this.hpfPrevY = prevY;
    return out;
  }

  private estimateSilenceMs(
    frames: Array<{ buffer: Buffer; ms: number }>,
  ): { leadingMs: number; trailingMs: number } {
    let leadingMs = 0;
    for (const frame of frames) {
      const stats = computeRmsAndPeak(frame.buffer);
      if (stats.rms >= this.speechRmsFloor) break;
      leadingMs += frame.ms;
    }

    let trailingMs = 0;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const stats = computeRmsAndPeak(frames[i]!.buffer);
      if (stats.rms >= this.speechRmsFloor) break;
      trailingMs += frames[i]!.ms;
    }

    return { leadingMs, trailingMs };
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
    const now = Date.now();
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
    const buf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    this.ingest(buf);
  }

  public ingest(pcm: Buffer): void {
    if (!pcm || pcm.length === 0) return;

    const bytesPerSample = this.inputCodec === 'pcmu' ? 1 : 2;
    const samples = pcm.length / bytesPerSample;
    const computedFrameMs = (samples / this.sampleRate) * 1000;
    const frameMs =
      Number.isFinite(computedFrameMs) && computedFrameMs > 0
        ? computedFrameMs
        : this.fallbackFrameMs;

    // First-frame log (helps confirm audio is arriving)
    if (!this.firstFrameLogged) {
      this.firstFrameLogged = true;
      log.info(
        {
          event: 'stt_first_audio_frame',
          frame_bytes: pcm.length,
          frame_ms: Math.round(frameMs),
          silence_end_ms: this.silenceEndMs,
          partial_interval_ms: this.partialIntervalMs,
          ...(this.logContext ?? {}),
        },
        'stt first audio frame',
      );
    }

    let rawMeta = getAudioMeta(pcm);
    if (!rawMeta) {
      rawMeta = this.buildAudioMeta({
        format: this.inputCodec === 'pcmu' ? 'pcmu' : 'pcm16le',
        sampleRateHz: this.sampleRate,
        channels: 1,
        bitDepth: this.inputCodec === 'pcmu' ? 8 : 16,
        lineage: ['rx.telnyx.raw'],
      });
      attachAudioMeta(pcm, rawMeta);
    }

    let frame =
      this.inputCodec === 'pcmu'
        ? pcmuToPcm16le(pcm)
        : pcm;

    // 🔑 APPLY RX POSTPROCESS HERE
    // 🔑 APPLY RX POSTPROCESS HERE (SAFE LE PCM16 <-> Int16)
    const sampleCount = Math.floor(frame.length / 2);
    const safePcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      safePcm[i] = frame.readInt16LE(i * 2);
    }

    const processed = postprocessPcm16(safePcm, this.sampleRate);

    const out = Buffer.allocUnsafe(processed.samples.length * 2);
    for (let i = 0; i < processed.samples.length; i += 1) {
      out.writeInt16LE(processed.samples[i]!, i * 2);
    }
    frame = out;



    let decodedMeta = appendLineage(
      rawMeta,
      this.inputCodec === 'pcmu' ? 'decode:pcmu->pcm16le' : 'passthrough:pcm16le',
    );
    attachAudioMeta(frame, decodedMeta);
    if (this.highpassEnabled) {
      frame = this.applyHighpassPcm16(frame);
      decodedMeta = appendLineage(decodedMeta, `filter:highpass_${this.highpassCutoffHz}hz`);
      attachAudioMeta(frame, decodedMeta);
    }
    if (!this.decodedProbeLogged) {
      this.decodedProbeLogged = true;
      probePcm('rx.decoded.pcm', frame, {
        ...decodedMeta,
        format: 'pcm16le',
        sampleRateHz: this.sampleRate,
        channels: 1,
        bitDepth: 16,
      });
    }
    const stats = computeRmsAndPeak(frame);
    this.updateRollingStats(stats);
    const gateRms = stats.rms >= this.speechRmsFloor;
    const gatePeak = stats.peak >= this.speechPeakFloor;
    const isSpeech = this.disableGates ? true : gateRms && gatePeak;

    if (this.inFlight && this.inFlightKind === 'final' && isSpeech) {
      this.abortInFlight('barge_in');
      this.resetUtteranceState();
    }

    if (!this.inSpeech) {
      // Maintain pre-roll buffer while idle
      this.addPreRollFrame(frame, frameMs);

      if (isSpeech) {
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.speechFrameStreak += 1;
      } else {
        this.speechFrameStreak = 0;
      }

      if (isSpeech && this.speechFrameStreak >= this.speechFramesRequired) {
        this.startSpeech(stats, frameMs);
        if (this.onSpeechStart) {
          this.onSpeechStart({
            rms: stats.rms,
            peak: stats.peak,
            frameMs,
            streak: this.speechFrameStreak,
          });
        }
      } else if (!this.disableGates) {
        const reason = this.resolveGateClosedReason(gateRms, gatePeak, this.speechFrameStreak);
        if (reason) {
          this.maybeLogGateClosed(reason, stats, frameMs);
        }
      }
      return;
    }

    // In speech: append to utterance
    this.appendUtterance(frame, frameMs);

    if (isSpeech) {
      // ✅ IMPORTANT: update lastSpeechAt continuously (not just at startSpeech)
      this.lastSpeechAt = Date.now();
      this.speechMs += frameMs;
      this.silenceMsAccum = 0;
      this.silenceFrameStreak = 0;
      this.silenceToFinalizeTimer = undefined;
    } else {
      this.silenceMsAccum += frameMs;
      if (this.silenceFrameStreak === 0) {
        this.silenceToFinalizeTimer = startStageTimer('stt_silence_to_finalize_ms', this.tenantLabel);
      }
      this.silenceFrameStreak += 1;
      const silenceFramesNeeded = Math.max(
        1,
        Math.ceil((this.silenceMinSeconds * 1000) / frameMs),
      );
      if (this.silenceFrameStreak >= silenceFramesNeeded) {
        if (this.silenceToFinalizeTimer) {
          this.silenceToFinalizeTimer();
          this.silenceToFinalizeTimer = undefined;
        }
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

    if (this.inSpeech && this.utteranceBytes > 0) {
      this.flushIfReady('stop');
    }
  }

  private flushIfReady(reason: 'interval' | 'silence' | 'stop'): void {
    if (reason === 'interval') {
      this.maybeSendPartial();
      return;
    }

    if (reason === 'stop') {
      this.finalizeUtterance('stop');
      return;
    }

    this.finalizeUtterance('silence');
  }

  private addPreRollFrame(pcm: Buffer, frameMs: number): void {
    if (this.preRollMaxMs <= 0) return;

    this.preRollFrames.push({ buffer: pcm, ms: frameMs });
    this.preRollMs += frameMs;
    this.mergeLineageFromBuffer(pcm);

    while (this.preRollMs > this.preRollMaxMs && this.preRollFrames.length > 0) {
      const dropped = this.preRollFrames.shift();
      if (!dropped) break;
      this.preRollMs -= dropped.ms;
    }
  }

  private startSpeech(stats: { rms: number; peak: number }, frameMs: number): void {
    this.inSpeech = true;
    this.lastSpeechAt = Date.now();
    this.silenceMsAccum = 0;
    this.silenceFrameStreak = 0;
    this.silenceToFinalizeTimer = undefined;
    this.speechMs = this.speechFrameStreak * frameMs;

    this.utteranceFrames = [...this.preRollFrames];
    this.utteranceMs = this.preRollMs;
    this.utteranceBytes = this.utteranceFrames.reduce((sum, frame) => sum + frame.buffer.length, 0);
    this.utteranceLineage = [];
    this.mergeLineageFromFrames(this.utteranceFrames);

    this.preRollFrames = [];
    this.preRollMs = 0;

    this.lastPartialAt = 0;
    this.lastPartialTranscript = '';
    this.lastNonEmptyPartialAt = 0;

    this.finalFlushAt = 0;
    this.finalTranscriptAccepted = false;

    markAudioSpan(
      'rx',
      this.buildAudioMeta({
        lineage: [...this.utteranceLineage],
      }),
    );

    log.info(
      {
        event: 'stt_speech_start',
        speech_rms: Number(stats.rms.toFixed(4)),
        speech_peak: Number(stats.peak.toFixed(4)),
        ...(this.logContext ?? {}),
      },
      'stt speech start',
    );
  }

  private appendUtterance(pcm: Buffer, frameMs: number): void {
    this.utteranceFrames.push({ buffer: pcm, ms: frameMs });
    this.utteranceMs += frameMs;
    this.utteranceBytes += pcm.length;
    this.mergeLineageFromBuffer(pcm);
  }

  private trimTrailingSilence(
    frames: Array<{ buffer: Buffer; ms: number }>,
  ): Array<{ buffer: Buffer; ms: number }> {
    if (frames.length === 0) return frames;

    let lastSpeechIndex = -1;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const stats = computeRmsAndPeak(frames[i].buffer);
      if (stats.rms >= this.speechRmsFloor) {
        lastSpeechIndex = i;
        break;
      }
    }

    if (lastSpeechIndex === -1) return frames;

    let endIndex = lastSpeechIndex;
    let tailMs = 0;
    for (let i = lastSpeechIndex + 1; i < frames.length; i += 1) {
      tailMs += frames[i].ms;
      endIndex = i;
      if (tailMs >= this.finalTailCushionMs) {
        break;
      }
    }

    if (endIndex >= frames.length - 1) return frames;
    return frames.slice(0, endIndex + 1);
  }

  private maybeSendPartial(): void {
    if (!this.inSpeech) return;
    if (this.inFlight) return;
    if (this.utteranceMs < this.minSpeechMs) return;

    const now = Date.now();
    if (this.lastPartialAt > 0 && now - this.lastPartialAt < this.partialIntervalMs) return;

    const payload = this.concatFrames(this.utteranceFrames);
    if (payload.length < this.partialMinBytes) {
      const stats = computeRmsAndPeak(payload);
      const silence = this.estimateSilenceMs(this.utteranceFrames);
      const audioMs = Math.round((payload.length / this.bytesPerSecond) * 1000);
      log.info(
        {
          event: 'stt_partial_skip_short',
          audio_ms: audioMs,
          audio_bytes: payload.length,
          rms: Number(stats.rms.toFixed(6)),
          peak: Number(stats.peak.toFixed(6)),
          leading_silence_ms: Math.round(silence.leadingMs),
          trailing_silence_ms: Math.round(silence.trailingMs),
          min_ms: this.partialMinMs,
          min_bytes: this.partialMinBytes,
          ...(this.logContext ?? {}),
        },
        'stt partial skipped (too short)',
      );
      return;
    }

    this.lastPartialAt = now;
    const stats = computeRmsAndPeak(payload);
    const silence = this.estimateSilenceMs(this.utteranceFrames);
    const audioMs = Math.round((payload.length / this.bytesPerSecond) * 1000);
    log.info(
      {
        event: 'stt_partial_submit',
        audio_ms: audioMs,
        audio_bytes: payload.length,
        rms: Number(stats.rms.toFixed(6)),
        peak: Number(stats.peak.toFixed(6)),
        leading_silence_ms: Math.round(silence.leadingMs),
        trailing_silence_ms: Math.round(silence.trailingMs),
        ...(this.logContext ?? {}),
      },
      'stt partial submit',
    );
    this.enqueueTranscription(payload, {
      reason: 'partial',
      isFinal: false,
      lineage: [...this.utteranceLineage],
    });
  }

  private finalizeUtterance(reason: FinalReason): void {
    if (!this.inSpeech || this.utteranceBytes === 0) {
      return;
    }

    // ✅ Record pre_stt_gate ONLY ONCE per utterance:
    // - only when silence triggers finalization
    // - only the first time we request a final flush (finalFlushAt == 0)
    if (this.finalFlushAt === 0) {
      this.finalFlushAt = Date.now();

      if (reason === 'silence' && this.lastSpeechAt > 0) {
        const gateMs = Date.now() - this.lastSpeechAt;
        observeStageDuration('pre_stt_gate', this.tenantLabel, gateMs);
      }
    }

    if (this.inFlight) {
      if (this.inFlightKind === 'final') {
        return;
      }
      this.abortInFlight('finalize');
    }

    const trimmedFrames = this.trimTrailingSilence(this.utteranceFrames);
    const trimmedMs = trimmedFrames.reduce((sum, frame) => sum + frame.ms, 0);
    const payload = this.concatFrames(trimmedFrames);
    const stats = computeRmsAndPeak(payload);
    const silence = this.estimateSilenceMs(trimmedFrames);
    const audioMs = Math.round((payload.length / this.bytesPerSecond) * 1000);

    observeStageDuration('stt_finalize_audio_ms', this.tenantLabel, trimmedMs);

    log.info(
      {
        event: 'stt_final_flush_forced',
        final_reason: reason,
        utterance_bytes: payload.length,
        utterance_ms: this.utteranceMs,
        duration_ms_estimate: Math.round(trimmedMs),
        audio_ms: audioMs,
        rms: Number(stats.rms.toFixed(6)),
        peak: Number(stats.peak.toFixed(6)),
        leading_silence_ms: Math.round(silence.leadingMs),
        trailing_silence_ms: Math.round(silence.trailingMs),
        below_floor: payload.length < this.finalMinBytes,
        ...(this.logContext ?? {}),
      },
      'stt final flush forced',
    );

    const lineage = [...this.utteranceLineage];
    if (trimmedFrames.length !== this.utteranceFrames.length) {
      lineage.push('trim:trailing_silence');
    }
    this.enqueueTranscription(payload, {
      reason: 'final',
      isFinal: true,
      finalReason: reason,
      lineage,
    });

    this.resetUtteranceState();
  }

  private concatFrames(frames: Array<{ buffer: Buffer }>): Buffer {
    if (frames.length === 1) return frames[0]!.buffer;
    return Buffer.concat(frames.map((f) => f.buffer));
  }

  private abortInFlight(reason: 'barge_in' | 'finalize'): void {
    if (!this.inFlight) {
      return;
    }

    if (this.inFlightAbort) {
      this.inFlightAbort.abort();
      this.inFlightAbort = undefined;
    }

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
    payload: Buffer,
    meta: {
      reason: 'partial' | 'final';
      isFinal: boolean;
      finalReason?: FinalReason;
      lineage?: string[];
    },
  ): void {
    if (this.inFlight) return;

    this.inFlight = true;
    this.inFlightKind = meta.reason;
    const token = (this.inFlightToken += 1);
    this.inFlightAbort = new AbortController();

    if (meta.isFinal) {
      this.finalizeToResultTimer = startStageTimer('stt_finalize_to_result_ms', this.tenantLabel);
    }

    void this.transcribePayload(payload, meta, token, this.inFlightAbort.signal)
      .catch((err) => {
        log.error({ err, ...(this.logContext ?? {}) }, 'stt transcription failed');
      })
      .finally(() => {
        if (this.inFlightToken !== token) {
          return;
        }
        this.inFlight = false;
        this.inFlightKind = undefined;
        this.inFlightAbort = undefined;
        this.finalizeToResultTimer = undefined;
      });
  }

  private async transcribePayload(
    payload: Buffer,
    meta: {
      reason: 'partial' | 'final';
      isFinal: boolean;
      finalReason?: FinalReason;
      lineage?: string[];
    },
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();

    const audioInput =
      this.provider.id === 'http_wav_json'
        ? ({
            audio: payload,
            sampleRateHz: this.sampleRate,
            encoding: 'wav',
            channels: 1,
          } as const)
        : ({
            audio: payload,
            sampleRateHz: this.sampleRate,
            encoding: 'pcm16le',
            channels: 1,
          } as const);

    const audioMeta = this.buildAudioMeta({
      format: audioInput.encoding === 'wav' ? 'wav' : 'pcm16le',
      sampleRateHz: audioInput.sampleRateHz,
      channels: 1,
      bitDepth: 16,
      lineage: meta.lineage ?? [],
      kind: meta.reason,
    });
    markAudioSpan('stt_submit', audioMeta);

    const endStt = startStageTimer('stt', this.tenantLabel);

    try {
      const result = await this.provider.transcribe(audioInput, {
        language: this.language,
        isPartial: meta.reason === 'partial',
        endpointUrl: this.whisperUrl,
        logContext: this.logContext,
        signal,
        audioMeta,
      });

      endStt();
      if (token !== this.inFlightToken) {
        return;
      }
      if (meta.isFinal && this.finalizeToResultTimer) {
        this.finalizeToResultTimer();
        this.finalizeToResultTimer = undefined;
      }

      const elapsedMs = Date.now() - startedAt;
      const text = normalizeWhitespace(result.text ?? '');

      markAudioSpan('stt_result', audioMeta);

      log.info(
        {
          event: 'stt_transcription_result',
          kind: meta.reason,
          elapsed_ms: elapsedMs,
          text_len: text.length,
          ...(this.logContext ?? {}),
        },
        'stt transcription result',
      );

      if (!text) {
        // If final came back empty, reset state
        if (meta.isFinal) {
          this.resetUtteranceState();
        }
        return;
      }

      if (meta.reason === 'partial') {
        // De-dupe rapid repeats
        if (text === this.lastPartialTranscript) return;
        this.lastPartialTranscript = text;

        if (isNonEmpty(text)) {
          this.lastNonEmptyPartialAt = Date.now();
          this.onTranscript(text, 'partial_fallback');
        }
        return;
      }

      // Final
      if (!this.finalTranscriptAccepted) {
        this.finalTranscriptAccepted = true;
        this.onTranscript(text, 'final');
      }

      this.resetUtteranceState();
    } catch (error) {
      endStt();
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      if (token === this.inFlightToken && meta.isFinal) {
        this.finalizeToResultTimer = undefined;
      }
      incStageError('stt', this.tenantLabel);
      throw error;
    }
  }

  private resetUtteranceState(): void {
    this.inSpeech = false;
    this.speechMs = 0;
    this.silenceMsAccum = 0;
    this.utteranceMs = 0;
    this.utteranceBytes = 0;
    this.utteranceFrames = [];
    this.utteranceLineage = [];
    this.speechFrameStreak = 0;
    this.silenceFrameStreak = 0;
    this.silenceToFinalizeTimer = undefined;
    this.lastPartialTranscript = '';
    this.lastNonEmptyPartialAt = 0;
    this.finalFlushAt = 0;
    this.finalTranscriptAccepted = false;
    this.lastSpeechAt = 0;
  }
}
