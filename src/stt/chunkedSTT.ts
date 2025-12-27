import { env } from '../env';
import { log } from '../log';
import { ChunkedSTTConfig, STTRequest, STTResult } from './types';

const DEFAULT_MIN_BYTES = 3200;
const wavDebugLogged = new Set<string>();
let wavDebugLoggedAnonymous = false;

const mediaDebugEnabled = (): boolean => {
  const value = process.env.MEDIA_DEBUG;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const SAMPLE_RATE_HZ = 8000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2;
const PARTIAL_WINDOW_MS = 2000;
const SPEECH_FRAMES_REQUIRED = 2;
const FINAL_MIN_BYTES = 800;
const PARTIAL_MAX_MIN_BYTES = 8000;
const PARTIAL_FALLBACK_MAX_AGE_MS = 3000;

function clampInt16(n: number): number {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
}

/**
 * Correct G.711 μ-law (PCMU) to linear PCM16 sample.
 * Telnyx streams PCMU at 8kHz by default.
 *
 * This implementation prevents overflow and matches the standard expansion curve.
 */
function muLawToPcmSample(uLawByte: number): number {
  // Invert all bits
  const u = (~uLawByte) & 0xff;

  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;

  // Standard μ-law decode:
  // sample = ((mantissa << 3) + BIAS) << exponent; sample -= BIAS; apply sign
  const BIAS = 0x84; // 132
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  if (sign) sample = -sample;

  return clampInt16(sample);
}

function muLawBufferToPcm16LE(muLaw: Buffer): Buffer {
  const output = Buffer.alloc(muLaw.length * 2);

  for (let i = 0; i < muLaw.length; i += 1) {
    const sample = muLawToPcmSample(muLaw[i]);
    output.writeInt16LE(sample, i * 2);
  }

  return output;
}

function upsamplePcm16le8kTo16kLinear(pcm16le: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16le.length / 2);
  if (sampleCount === 0) {
    return Buffer.alloc(0);
  }

  const output = Buffer.alloc(sampleCount * 2 * 2);
  for (let i = 0; i < sampleCount - 1; i += 1) {
    const current = pcm16le.readInt16LE(i * 2);
    const next = pcm16le.readInt16LE((i + 1) * 2);
    const interp = clampInt16(Math.round((current + next) / 2));
    const outIndex = i * 4;
    output.writeInt16LE(current, outIndex);
    output.writeInt16LE(interp, outIndex + 2);
  }

  const last = pcm16le.readInt16LE((sampleCount - 1) * 2);
  const lastOutIndex = (sampleCount - 1) * 4;
  output.writeInt16LE(last, lastOutIndex);
  output.writeInt16LE(last, lastOutIndex + 2);
  return output;
}

function computePcmStatsFromMuLaw(muLaw: Buffer, stride: number = 8): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;

  for (let i = 0; i < muLaw.length; i += stride) {
    const sample = muLawToPcmSample(muLaw[i]);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
    count += 1;
  }

  const rms = count > 0 ? Math.round(Math.sqrt(sumSquares / count)) : 0;
  return { peak, rms };
}

function computePcmStatsFromPcm16LE(pcm16le: Buffer, stride: number = 8): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;

  const sampleCount = Math.floor(pcm16le.length / 2);
  for (let i = 0; i < sampleCount; i += stride) {
    const sample = pcm16le.readInt16LE(i * 2);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
    count += 1;
  }

  const rms = count > 0 ? Math.round(Math.sqrt(sumSquares / count)) : 0;
  return { peak, rms };
}

function pcmDurationMs(pcm16le: Buffer, sampleRate: number = SAMPLE_RATE_HZ): number {
  if (pcm16le.length === 0) {
    return 0;
  }
  const samples = pcm16le.length / 2;
  return (samples / sampleRate) * 1000;
}

function wavHeader(pcmDataBytes: number, sampleRate: number, numChannels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function makeWavFromMuLaw8k(muLaw: Buffer): Buffer {
  const pcm16le8k = muLawBufferToPcm16LE(muLaw);
  const pcm16le16k = upsamplePcm16le8kTo16kLinear(pcm16le8k);
  const header = wavHeader(pcm16le16k.length, 16000, 1);
  return Buffer.concat([header, pcm16le16k]);
}

function makeWavFromPcm16le8k(pcm16le: Buffer): Buffer {
  // Assume pcm16le is little-endian signed int16 samples at 8kHz mono.
  const pcm16le16k = upsamplePcm16le8kTo16kLinear(pcm16le);
  const header = wavHeader(pcm16le16k.length, 16000, 1);
  return Buffer.concat([header, pcm16le16k]);
}

function extractCallControlId(logContext?: Record<string, unknown>): string | undefined {
  const value = logContext?.call_control_id;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface ChunkedSTTOptions extends ChunkedSTTConfig {
  onTranscript: (result: {
    text: string;
    isFinal: boolean;
    source?: 'partial_fallback';
  }) => void | Promise<void>;
  onSpeechStart?: () => void | Promise<void>;
  logContext?: Record<string, unknown>;
  whisperUrl?: string;
  language?: string;
}

type AudioEncoding = 'pcmu' | 'pcm16le';

/**
 * We keep this compatible with existing callers by defaulting to PCMU (μ-law).
 * If you ever switch Telnyx streaming to linear PCM, you can pass encoding: 'pcm16le'.
 */
function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';

  const record = result as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.transcription === 'string') return record.transcription;

  return '';
}

function buildWhisperUrl(whisperUrl: string, language?: string): string {
  if (!language) return whisperUrl;
  const separator = whisperUrl.includes('?') ? '&' : '?';
  return `${whisperUrl}${separator}language=${encodeURIComponent(language)}`;
}

export async function transcribeChunk(
  request: STTRequest & {
    whisperUrl?: string;
    language?: string;
    encoding?: AudioEncoding;
    logContext?: Record<string, unknown>;
  },
): Promise<STTResult> {
  const whisperUrl = buildWhisperUrl(request.whisperUrl ?? env.WHISPER_URL, request.language);

  const encoding: AudioEncoding = request.encoding ?? 'pcmu';

  const wavPayload =
    encoding === 'pcm16le' ? makeWavFromPcm16le8k(request.audio) : makeWavFromMuLaw8k(request.audio);

  if (mediaDebugEnabled()) {
    const callControlId = extractCallControlId(request.logContext);
    const shouldLog = callControlId
      ? !wavDebugLogged.has(callControlId)
      : !wavDebugLoggedAnonymous;
    if (shouldLog) {
      if (callControlId) {
        wavDebugLogged.add(callControlId);
      } else {
        wavDebugLoggedAnonymous = true;
      }

      const sampleRate = wavPayload.length >= 28 ? wavPayload.readUInt32LE(24) : undefined;
      const bitsPerSample = wavPayload.length >= 36 ? wavPayload.readUInt16LE(34) : undefined;
      const channels = wavPayload.length >= 24 ? wavPayload.readUInt16LE(22) : undefined;
      const firstSamples: number[] = [];
      const dataOffset = 44;
      for (let i = 0; i < 10; i += 1) {
        const offset = dataOffset + i * 2;
        if (offset + 2 > wavPayload.length) {
          break;
        }
        firstSamples.push(wavPayload.readInt16LE(offset));
      }

      log.info(
        {
          event: 'wav_debug',
          sample_rate: sampleRate,
          bits_per_sample: bitsPerSample,
          channels,
          first_samples: firstSamples,
          ...(request.logContext ?? {}),
        },
        'wav debug',
      );
    }
  }

  if (mediaDebugEnabled()) {
    log.info(
      {
        event: 'whisper_request',
        encoding,
        wav_bytes: wavPayload.length,
      },
      'whisper request',
    );
  }

  const response = await fetch(whisperUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
    },
    body: new Uint8Array(wavPayload),
  });

  if (!response.ok) {
    const body = await response.text();
    const preview = body.length > 500 ? `${body.slice(0, 500)}…` : body;

    log.error(
      { event: 'whisper_error', status: response.status, body_preview: preview },
      'whisper request failed',
    );

    throw new Error(`whisper error ${response.status}: ${preview}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as unknown;
    const result = {
      text: extractText(data),
      confidence:
        typeof (data as { confidence?: unknown }).confidence === 'number'
          ? (data as { confidence?: number }).confidence
          : undefined,
    };

    if (mediaDebugEnabled()) {
      log.info(
        { event: 'whisper_response', status: response.status, transcript_length: result.text.length },
        'whisper response',
      );
    }

    return result;
  }

  const text = await response.text();

  if (mediaDebugEnabled()) {
    log.info(
      { event: 'whisper_response', status: response.status, transcript_length: text.length },
      'whisper response',
    );
  }

  return { text };
}

export class ChunkedSTT {
  private readonly chunkMs: number;
  private readonly silenceMs: number;
  private readonly minBytes: number;
  private readonly onTranscript: (result: {
    text: string;
    isFinal: boolean;
    source?: 'partial_fallback';
  }) => void | Promise<void>;
  private readonly onSpeechStart?: () => void | Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private flushQueue: Promise<void> = Promise.resolve();
  private inFlight = false;
  private pendingFinalReason: 'silence' | 'stop' | 'max' | null = null;
  private readonly logContext?: Record<string, unknown>;
  private readonly whisperUrl?: string;
  private readonly language?: string;

  private firstFrameLogged = false;
  private inSpeech = false;
  private speechMs = 0;
  private silenceMsAccum = 0;
  private utteranceMs = 0;
  private utteranceBytes = 0;
  private preRollFrames: Array<{ buffer: Buffer; ms: number }> = [];
  private preRollMs = 0;
  private utteranceFrames: Array<{ buffer: Buffer; ms: number }> = [];
  private speechFrameStreak = 0;
  private lastPartialAt = 0;
  private lastPartialTranscript = '';
  private lastNonEmptyPartialAt = 0;
  private finalFlushAt = 0;
  private finalTranscriptAccepted = false;

  constructor(options: ChunkedSTTOptions) {
    this.chunkMs = options.chunkMs;
    this.silenceMs = options.silenceMs;
    this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    this.onTranscript = options.onTranscript;
    this.onSpeechStart = options.onSpeechStart;
    this.logContext = options.logContext;
    this.whisperUrl = options.whisperUrl;
    this.language = options.language;

    this.timer = setInterval(() => {
      this.flushIfReady('interval');
    }, this.chunkMs);
    this.timer.unref?.();
  }

  public ingest(frame: Buffer): void {
    if (!frame || frame.length === 0) return;

    if (!this.firstFrameLogged && mediaDebugEnabled()) {
      this.firstFrameLogged = true;
      const head = frame.subarray(0, 12).toString('hex');
      log.info(
        { event: 'media_first_frame', bytes: frame.length, head_hex: head, ...(this.logContext ?? {}) },
        'media first frame',
      );
    }

    const pcm = muLawBufferToPcm16LE(frame);
    const frameMs = pcmDurationMs(pcm);
    const stats = computePcmStatsFromPcm16LE(pcm, 8);
    const isSpeech = stats.rms >= env.STT_RMS_THRESHOLD;

    if (!this.inSpeech) {
      this.addPreRollFrame(pcm, frameMs);
      if (isSpeech) {
        this.speechFrameStreak += 1;
      } else {
        this.speechFrameStreak = 0;
      }

      if (isSpeech && this.speechFrameStreak >= SPEECH_FRAMES_REQUIRED) {
        this.startSpeech(stats, frameMs);
      }
      return;
    }

    this.appendUtterance(pcm, frameMs);

    if (isSpeech) {
      this.speechMs += frameMs;
      this.silenceMsAccum = 0;
    } else {
      this.silenceMsAccum += frameMs;
    }

    if (this.utteranceMs >= env.STT_MAX_UTTERANCE_MS) {
      this.finalizeUtterance('max');
      return;
    }

    if (this.silenceMsAccum >= env.STT_SILENCE_END_MS) {
      this.flushIfReady('silence');
    }
  }

  public stop(): void {
    clearInterval(this.timer);
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
    this.preRollFrames.push({ buffer: pcm, ms: frameMs });
    this.preRollMs += frameMs;

    while (this.preRollMs > env.STT_PRE_ROLL_MS && this.preRollFrames.length > 0) {
      const removed = this.preRollFrames.shift();
      if (removed) {
        this.preRollMs -= removed.ms;
      }
    }
  }

  private startSpeech(stats: { rms: number; peak: number }, frameMs: number): void {
    this.inSpeech = true;
    this.silenceMsAccum = 0;
    this.speechMs = this.speechFrameStreak * frameMs;
    this.utteranceFrames = [...this.preRollFrames];
    this.utteranceMs = this.preRollMs;
    this.utteranceBytes = this.utteranceFrames.reduce((sum, frame) => sum + frame.buffer.length, 0);
    this.preRollFrames = [];
    this.preRollMs = 0;
    this.lastPartialAt = 0;
    this.lastPartialTranscript = '';
    this.lastNonEmptyPartialAt = 0;
    this.finalFlushAt = 0;
    this.finalTranscriptAccepted = false;
    this.speechFrameStreak = 0;

    if (mediaDebugEnabled()) {
      log.info(
        {
          event: 'stt_speech_start',
          rms: stats.rms,
          peak: stats.peak,
          rms_threshold: env.STT_RMS_THRESHOLD,
          ...(this.logContext ?? {}),
        },
        'stt speech start',
      );
    }

    this.emitSpeechStart();
  }

  private emitSpeechStart(): void {
    if (!this.onSpeechStart) {
      return;
    }

    const result = this.onSpeechStart();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((error: unknown) => {
        log.error({ err: error, ...(this.logContext ?? {}) }, 'stt speech start handler failed');
      });
    }
  }

  private appendUtterance(pcm: Buffer, frameMs: number): void {
    this.utteranceFrames.push({ buffer: pcm, ms: frameMs });
    this.utteranceMs += frameMs;
    this.utteranceBytes += pcm.length;
  }

  private resetUtteranceState(): void {
    this.inSpeech = false;
    this.speechMs = 0;
    this.silenceMsAccum = 0;
    this.utteranceMs = 0;
    this.utteranceBytes = 0;
    this.utteranceFrames = [];
    this.speechFrameStreak = 0;
    this.lastPartialTranscript = '';
    this.lastNonEmptyPartialAt = 0;
    this.finalFlushAt = 0;
    this.finalTranscriptAccepted = false;
  }

  private maybeSendPartial(): void {
    if (!this.inSpeech || this.utteranceBytes === 0) {
      return;
    }

    const now = Date.now();
    if (this.inFlight) {
      log.info(
        {
          event: 'stt_flush_skipped',
          reason: 'partial',
          bytes: this.utteranceBytes,
          min_bytes: this.minBytes,
          in_flight: true,
          ...(this.logContext ?? {}),
        },
        'stt flush skipped',
      );
      return;
    }

    if (now - this.lastPartialAt < env.STT_PARTIAL_EVERY_MS) {
      return;
    }

    if (this.utteranceMs < env.STT_MIN_UTTERANCE_MS) {
      return;
    }

    const windowMs = Math.min(this.utteranceMs, PARTIAL_WINDOW_MS);
    const tail = this.buildTailBuffer(windowMs);
    const computedMinBytes = Math.max(
      this.minBytes,
      Math.floor(PCM_BYTES_PER_SECOND * env.STT_MIN_SECONDS),
    );
    const minBytes = Math.min(computedMinBytes, PARTIAL_MAX_MIN_BYTES);

    if (tail.bytes < minBytes) {
      log.info(
        {
          event: 'stt_flush_skipped',
          reason: 'partial',
          bytes: tail.bytes,
          min_bytes: minBytes,
          in_flight: false,
          ...(this.logContext ?? {}),
        },
        'stt flush skipped',
      );
      return;
    }

    this.lastPartialAt = now;
    this.enqueueTranscription(tail.buffer, {
      reason: 'partial',
      isFinal: false,
    });
  }

  private finalizeUtterance(reason: 'silence' | 'stop' | 'max'): void {
    if (!this.inSpeech || this.utteranceBytes === 0) {
      return;
    }

    if (this.finalFlushAt === 0) {
      this.finalFlushAt = Date.now();
    }

    if (this.inFlight) {
      this.pendingFinalReason = reason;
      log.info(
        {
          event: 'stt_final_flush_deferred',
          reason,
          bytes: this.utteranceBytes,
          in_flight: true,
          ...(this.logContext ?? {}),
        },
        'stt final flush deferred',
      );
      return;
    }

    this.pendingFinalReason = null;

    if (mediaDebugEnabled()) {
      log.info(
        {
          event: 'stt_speech_end',
          reason,
          speech_ms: this.speechMs,
          silence_ms: this.silenceMsAccum,
          utterance_ms: this.utteranceMs,
          short_utterance: this.speechMs < env.STT_MIN_UTTERANCE_MS,
          ...(this.logContext ?? {}),
        },
        'stt speech end',
      );
    }

    const payload = this.buildUtteranceBuffer();
    log.info(
      {
        event: 'stt_final_flush_forced',
        bytes: payload.length,
        utterance_ms: this.utteranceMs,
        duration_ms_estimate: Math.round((payload.length / PCM_BYTES_PER_SECOND) * 1000),
        below_floor: payload.length < FINAL_MIN_BYTES,
        ...(this.logContext ?? {}),
      },
      'stt final flush forced',
    );
    this.enqueueTranscription(payload, {
      reason: 'final',
      isFinal: true,
      finalReason: reason,
    });
  }

  private buildUtteranceBuffer(): Buffer {
    return Buffer.concat(
      this.utteranceFrames.map((frame) => frame.buffer),
      this.utteranceBytes,
    );
  }

  private buildTailBuffer(windowMs: number): { buffer: Buffer; bytes: number } {
    if (this.utteranceFrames.length === 0) {
      return { buffer: Buffer.alloc(0), bytes: 0 };
    }

    let collectedMs = 0;
    const chunks: Buffer[] = [];
    for (let i = this.utteranceFrames.length - 1; i >= 0; i -= 1) {
      const frame = this.utteranceFrames[i];
      chunks.push(frame.buffer);
      collectedMs += frame.ms;
      if (collectedMs >= windowMs) {
        break;
      }
    }
    chunks.reverse();
    const bytes = chunks.reduce((sum, buffer) => sum + buffer.length, 0);
    return { buffer: Buffer.concat(chunks, bytes), bytes };
  }

  private enqueueTranscription(
    payload: Buffer,
    options: { reason: 'partial' | 'final' | 'final_retry'; isFinal: boolean; finalReason?: 'silence' | 'stop' | 'max' },
  ): void {
    const clearAfter = options.isFinal;
    this.inFlight = true;

    log.info(
      {
        event: 'stt_flush',
        reason: options.reason,
        bytes: payload.length,
        in_flight: this.inFlight,
        cleared: clearAfter,
        final_reason: options.finalReason,
        ...(this.logContext ?? {}),
      },
      'stt flush',
    );

    this.flushQueue = this.flushQueue
      .then(async () => {
        if (options.reason === 'partial') {
          const text = await this.transcribePayload(payload, options.reason);
          log.info(
            {
              event: 'stt_partial_transcript',
              text,
              text_length: text.length,
              source: 'whisper_partial',
              ...(this.logContext ?? {}),
            },
            'stt partial transcript',
          );
          if (text !== '') {
            this.lastPartialTranscript = text;
            this.lastNonEmptyPartialAt = Date.now();
            await this.onTranscript({ text, isFinal: false });
          }
          return;
        }

        await this.transcribeFinal(payload, options.finalReason ?? 'silence');
      })
      .catch((error: unknown) => {
        log.error({ err: error, reason: options.reason, ...(this.logContext ?? {}) }, 'stt chunk transcription failed');
      })
      .finally(() => {
        if (clearAfter) {
          this.resetUtteranceState();
        }
        this.inFlight = false;
        if (this.pendingFinalReason) {
          const pendingReason = this.pendingFinalReason;
          this.pendingFinalReason = null;
          this.finalizeUtterance(pendingReason);
        }
      });
  }

  private async transcribePayload(payload: Buffer, reason: 'partial' | 'final' | 'final_retry'): Promise<string> {
    log.info(
      {
        event: 'stt_chunk_sent',
        bytes: payload.length,
        reason,
        ...(this.logContext ?? {}),
      },
      'stt chunk sent',
    );

    const startedAt = Date.now();
    const result = await transcribeChunk({
      audio: payload,
      whisperUrl: this.whisperUrl,
      language: this.language,
      encoding: 'pcm16le',
      logContext: this.logContext,
    });

    const durationMs = Date.now() - startedAt;
    const text = result.text.trim();

    log.info(
      {
        event: 'stt_chunk_transcribed',
        duration_ms: durationMs,
        bytes: payload.length,
        text_length: text.length,
        reason,
        ...(this.logContext ?? {}),
      },
      'stt chunk transcribed',
    );

    return text;
  }

  private async transcribeFinal(payload: Buffer, finalReason: 'silence' | 'stop' | 'max'): Promise<void> {
    let text = await this.transcribePayload(payload, 'final');

    if (text === '') {
      const retryWindowMs = Math.min(this.utteranceMs, 2500);
      const retryTail = this.buildTailBuffer(retryWindowMs);
      if (retryTail.bytes > 0) {
        const retryText = await this.transcribePayload(retryTail.buffer, 'final_retry');
        log.info(
          {
            event: 'stt_final_retry',
            text_length: retryText.length,
            final_reason: finalReason,
            ...(this.logContext ?? {}),
          },
          'stt final retry',
        );
        text = retryText.trim();
      }
    }

    if (text === '') {
      log.info(
        {
          event: 'stt_transcript_empty_final',
          final_reason: finalReason,
          bytes: payload.length,
          utterance_ms: this.utteranceMs,
          speech_ms: this.speechMs,
          silence_ms: this.silenceMsAccum,
          duration_ms_estimate: Math.round((payload.length / PCM_BYTES_PER_SECOND) * 1000),
          ...(this.logContext ?? {}),
        },
        'stt transcript empty',
      );
      const referenceTime = this.finalFlushAt || Date.now();
      const partialAgeMs = Math.max(0, referenceTime - this.lastNonEmptyPartialAt);
      const hasRecentPartial =
        this.lastPartialTranscript !== '' &&
        this.lastNonEmptyPartialAt > 0 &&
        partialAgeMs <= PARTIAL_FALLBACK_MAX_AGE_MS;
      if (hasRecentPartial) {
        const promoted = this.lastPartialTranscript;
        log.info(
          {
            event: 'stt_transcript_promoted',
            source: 'promoted_partial',
            text_length: promoted.length,
            final_reason: finalReason,
            ...(this.logContext ?? {}),
          },
          'stt transcript promoted',
        );
        if (!this.finalTranscriptAccepted) {
          this.finalTranscriptAccepted = true;
          await this.onTranscript({ text: promoted, isFinal: true, source: 'partial_fallback' });
        }
      }
      return;
    }

    if (mediaDebugEnabled()) {
      log.info({ event: 'stt_transcript', text, ...(this.logContext ?? {}) }, 'stt transcript');
    }

    if (!this.finalTranscriptAccepted) {
      this.finalTranscriptAccepted = true;
      await this.onTranscript({ text, isFinal: true });
    }
  }
}
