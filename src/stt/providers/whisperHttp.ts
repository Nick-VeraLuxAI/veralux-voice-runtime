// src/stt/providers/whisperHttp.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fetch } from 'undici';

import { env } from '../../env';
import { log } from '../../log';
import { observeStageDuration, startStageTimer, incStageError } from '../../metrics';

import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';

import type { AudioMeta } from '../../diagnostics/audioProbe';
import { appendLineage, probeWav } from '../../diagnostics/audioProbe';
import { parseWavInfo } from '../../audio/wavInfo';

import { assertLooksLikeWav } from '../wavGuard';
import { preWhisperGate } from '../../audio/preWhisperGate';

const WAV_SAMPLE_RATE_HZ = 16000;
const PCM_8K_SAMPLE_RATE_HZ = 8000;

const wavDebugLogged = new Set<string>();
let wavDebugLoggedAnonymous = false;

const whisperDumpCounters = new Map<string, number>();

// Dedupe state: same call + partial + same payload => skip sending
const lastPartialSha1ByCall = new Map<string, string>();

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

const mediaDebugEnabled = (): boolean => parseBoolEnv(process.env.MEDIA_DEBUG);
const whisperDumpEnabled = (): boolean => parseBoolEnv(process.env.STT_DEBUG_DUMP_WHISPER_WAVS);
const preWhisperGateEnabled = (): boolean => parseBoolEnv(process.env.STT_PREWHISPER_GATE);
const disablePartials = (): boolean => parseBoolEnv(process.env.STT_DISABLE_PARTIALS);
const forceNormalizeWav = (): boolean => parseBoolEnv(process.env.STT_FORCE_NORMALIZE_WAV);

// Simple trace mode (independent of MEDIA_DEBUG)
const sttTraceEnabled = (): boolean => parseBoolEnv(process.env.STT_TRACE);
const sttTraceLimit = (): number => {
  const n = Number.parseInt(process.env.STT_TRACE_LIMIT ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
};
const traceCountsByCall = new Map<string, number>();
function shouldTrace(callId: string): boolean {
  if (!sttTraceEnabled()) return false;
  const limit = sttTraceLimit();
  if (limit === 0) return true;
  const n = (traceCountsByCall.get(callId) ?? 0) + 1;
  traceCountsByCall.set(callId, n);
  return n <= limit;
}

function debugDir(): string {
  return process.env.STT_DEBUG_DIR && process.env.STT_DEBUG_DIR.trim() !== ''
    ? process.env.STT_DEBUG_DIR.trim()
    : '/tmp/veralux-stt-debug';
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function sha1_10(buf: Buffer): string {
  return sha1Hex(buf).slice(0, 10);
}

function extractCallControlId(logContext?: Record<string, unknown>): string | undefined {
  const value = logContext?.call_control_id;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function maybeDumpWhisperWav(
  wavPayload: Buffer,
  kind: 'partial' | 'final',
  logContext?: Record<string, unknown>,
): Promise<void> {
  if (!whisperDumpEnabled()) return;

  const callControlId = extractCallControlId(logContext) ?? 'unknown';
  const safeId = sanitizeFilePart(callControlId);
  const seq = (whisperDumpCounters.get(safeId) ?? 0) + 1;
  whisperDumpCounters.set(safeId, seq);

  const dir = debugDir();
  const h10 = sha1_10(wavPayload);
  const filePath = path.join(dir, `whisper_${safeId}_${kind}_${seq}_${h10}_${Date.now()}.wav`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, wavPayload);
    let audioMs: number | null = null;
    try {
      const info = parseWavInfo(wavPayload);
      audioMs = Math.round(info.durationMs);
    } catch {
      audioMs = null;
    }
    log.info(
      { event: 'stt_whisper_wav_dumped', file_path: filePath, kind, sha1_10: h10, ...(logContext ?? {}) },
      'stt whisper wav dumped',
    );
    log.info(
      {
        event: 'stt_wav_dumped',
        call_control_id: callControlId,
        kind,
        audio_ms: audioMs,
        sha1_10: h10,
        file_path: filePath,
        ...(logContext ?? {}),
      },
      'stt wav dumped',
    );
  } catch (error) {
    log.warn(
      { event: 'stt_whisper_wav_dump_failed', file_path: filePath, err: error, ...(logContext ?? {}) },
      'stt whisper wav dump failed',
    );
  }
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
  if (sampleCount === 0) return Buffer.alloc(0);

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

function wavHeader(pcmDataBytes: number, sampleRate: number, numChannels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function makeWavFromMuLaw8k(muLaw: Buffer): Buffer {
  const pcm16le8k = muLawBufferToPcm16LE(muLaw);
  const pcm16le16k = upsamplePcm16le8kTo16kLinear(pcm16le8k);
  const header = wavHeader(pcm16le16k.length, WAV_SAMPLE_RATE_HZ, 1);
  return Buffer.concat([header, pcm16le16k]);
}

function makeWavFromPcm16le8k(pcm16le: Buffer): Buffer {
  const pcm16le16k = upsamplePcm16le8kTo16kLinear(pcm16le);
  const header = wavHeader(pcm16le16k.length, WAV_SAMPLE_RATE_HZ, 1);
  return Buffer.concat([header, pcm16le16k]);
}

function makeWavFromPcm16le(pcm16le: Buffer, sampleRateHz: number): Buffer {
  const header = wavHeader(pcm16le.length, sampleRateHz, 1);
  return Buffer.concat([header, pcm16le]);
}

/**
 * Whisper servers vary a lot:
 * - { text: "..." }
 * - { transcription: "..." }
 * - { result: { text: "..." } }
 * - { segments: [{ text: "..." }, ...] }
 */
function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;

  if (typeof record.text === 'string') return record.text;
  if (typeof record.transcription === 'string') return record.transcription;

  const maybeResult = record.result;
  if (maybeResult && typeof maybeResult === 'object') {
    const r = maybeResult as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.transcription === 'string') return r.transcription;
  }

  const segments = record.segments;
  if (Array.isArray(segments)) {
    const parts: string[] = [];
    for (const seg of segments) {
      if (seg && typeof seg === 'object') {
        const s = seg as Record<string, unknown>;
        if (typeof s.text === 'string' && s.text.trim() !== '') parts.push(s.text.trim());
      }
    }
    if (parts.length > 0) return parts.join(' ').trim();
  }

  return '';
}

function parseWavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;

  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const dataBytes = wav.readUInt32LE(40);
  const bytesPerSample = (bitsPerSample / 8) * channels;

  if (!sampleRate || !bytesPerSample) return null;
  const safeDataBytes = Math.min(dataBytes, Math.max(0, wav.length - 44));
  return (safeDataBytes / (sampleRate * bytesPerSample)) * 1000;
}

function computeAudioMs(input: STTAudioInput, wavPayload: Buffer): number {
  if (input.encoding === 'wav') {
    const parsed = parseWavDurationMs(wavPayload);
    if (parsed !== null) return parsed;
    const dataBytes = Math.max(0, wavPayload.length - 44);
    return (dataBytes / (input.sampleRateHz * 2)) * 1000;
  }
  const bytesPerSample = input.encoding === 'pcmu' ? 1 : 2;
  return (input.audio.length / (input.sampleRateHz * bytesPerSample)) * 1000;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function buildWhisperUrl(whisperUrl: string, language?: string): string {
  if (!language) return whisperUrl;
  const separator = whisperUrl.includes('?') ? '&' : '?';
  return `${whisperUrl}${separator}language=${encodeURIComponent(language)}`;
}

function prepareWavPayload(input: STTAudioInput, meta: AudioMeta | undefined): { wav: Buffer; meta: AudioMeta } {
  let nextMeta: AudioMeta = meta ?? {};

  if (input.encoding === 'wav') {
    nextMeta = appendLineage(nextMeta, 'passthrough:wav');
    nextMeta = { ...nextMeta, format: 'wav' };
    return { wav: input.audio, meta: nextMeta };
  }

  if (input.encoding === 'pcmu') {
    if (input.sampleRateHz !== PCM_8K_SAMPLE_RATE_HZ) {
      throw new Error(`unsupported pcmu sample rate: ${input.sampleRateHz}`);
    }
    nextMeta = appendLineage(nextMeta, 'decode:pcmu->pcm16le');
    nextMeta = appendLineage(nextMeta, `resample:${PCM_8K_SAMPLE_RATE_HZ}->${WAV_SAMPLE_RATE_HZ}`);
    nextMeta = appendLineage(nextMeta, 'wrap:wav');
    nextMeta = { ...nextMeta, sampleRateHz: WAV_SAMPLE_RATE_HZ, channels: 1, bitDepth: 16, format: 'wav' };
    return { wav: makeWavFromMuLaw8k(input.audio), meta: nextMeta };
  }

  if (input.encoding === 'pcm16le') {
    if (input.sampleRateHz === PCM_8K_SAMPLE_RATE_HZ) {
      nextMeta = appendLineage(nextMeta, `resample:${PCM_8K_SAMPLE_RATE_HZ}->${WAV_SAMPLE_RATE_HZ}`);
      nextMeta = appendLineage(nextMeta, 'wrap:wav');
      nextMeta = { ...nextMeta, sampleRateHz: WAV_SAMPLE_RATE_HZ, channels: 1, bitDepth: 16, format: 'wav' };
      return { wav: makeWavFromPcm16le8k(input.audio), meta: nextMeta };
    }
    nextMeta = appendLineage(nextMeta, 'wrap:wav');
    nextMeta = { ...nextMeta, sampleRateHz: input.sampleRateHz, channels: 1, bitDepth: 16, format: 'wav' };
    return { wav: makeWavFromPcm16le(input.audio, input.sampleRateHz), meta: nextMeta };
  }

  throw new Error(`unsupported audio encoding: ${input.encoding}`);
}

function logWavDebug(wavPayload: Buffer, logContext?: Record<string, unknown>): void {
  const callControlId = extractCallControlId(logContext);
  const shouldLog = callControlId ? !wavDebugLogged.has(callControlId) : !wavDebugLoggedAnonymous;
  if (!shouldLog) return;

  if (callControlId) wavDebugLogged.add(callControlId);
  else wavDebugLoggedAnonymous = true;

  const sampleRate = wavPayload.length >= 28 ? wavPayload.readUInt32LE(24) : undefined;
  const bitsPerSample = wavPayload.length >= 36 ? wavPayload.readUInt16LE(34) : undefined;
  const channels = wavPayload.length >= 24 ? wavPayload.readUInt16LE(22) : undefined;

  const firstSamples: number[] = [];
  const dataOffset = 44;
  for (let i = 0; i < 10; i += 1) {
    const offset = dataOffset + i * 2;
    if (offset + 2 > wavPayload.length) break;
    firstSamples.push(wavPayload.readInt16LE(offset));
  }

  log.info(
    {
      event: 'wav_debug',
      sample_rate: sampleRate,
      bits_per_sample: bitsPerSample,
      channels,
      wav_bytes: wavPayload.length,
      sha1_10: sha1_10(wavPayload),
      first_samples: firstSamples,
      ...(logContext ?? {}),
    },
    'wav debug',
  );
}

function previewText(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export class WhisperHttpProvider implements STTProvider {
  public readonly id = 'whisper_http';
  public readonly supportsPartials = true;

  public async transcribe(audio: STTAudioInput, opts: STTOptions = {}): Promise<STTTranscript> {
    const isFinal = !opts.isPartial;

    // Optional: hard-disable partials (so you can isolate finals)
    if (!isFinal && disablePartials()) {
      return { text: '', isFinal: false, raw: { skipped: 'partials_disabled' } };
    }

    const baseUrl = opts.endpointUrl ?? process.env.WHISPER_URL ?? env.WHISPER_URL;
    if (!baseUrl) throw new Error('WHISPER_URL is not set');

    const whisperUrl = buildWhisperUrl(baseUrl, opts.language);

    const callControlId = extractCallControlId(opts.logContext) ?? (opts.audioMeta?.callId ?? 'unknown');
    const safeCallKey = sanitizeFilePart(callControlId);

    const baseMeta: AudioMeta = {
      ...(opts.audioMeta ?? {}),
      logContext: opts.logContext ?? opts.audioMeta?.logContext,
      kind: opts.isPartial ? 'partial' : 'final',
    };

    // Build WAV bytes
    const gateEnabled = preWhisperGateEnabled();
    let wavPayload: Buffer;
    let wavMeta: AudioMeta;
    let audioForMetrics = audio;

    if (gateEnabled || forceNormalizeWav()) {
      // preWhisperGate produces canonical 16k mono wav
      const gate = await preWhisperGate({
        buf: audio.audio,
        hints: {
          codec: opts.audioMeta?.codec ?? audio.encoding,
          sampleRate: audio.sampleRateHz,
          channels: audio.channels ?? 1,
          callId: callControlId,
        },
      });

      wavPayload = gate.wav16kMono;
      wavMeta = appendLineage(baseMeta, 'prewhisper_gate');
      wavMeta = { ...wavMeta, sampleRateHz: WAV_SAMPLE_RATE_HZ, channels: 1, bitDepth: 16, format: 'wav' };
      audioForMetrics = { audio: wavPayload, sampleRateHz: WAV_SAMPLE_RATE_HZ, encoding: 'wav', channels: 1 };
    } else {
      // minimal wrap/resample for legacy callers
      const prepared = prepareWavPayload(audio, baseMeta);
      wavPayload = prepared.wav;
      wavMeta = prepared.meta;
      audioForMetrics = {
        audio: wavPayload,
        sampleRateHz: wavMeta.sampleRateHz ?? audio.sampleRateHz,
        encoding: 'wav',
        channels: 1,
      };
    }

    // Validate + guard
    assertLooksLikeWav(wavPayload, {
      provider: 'whisper_http',
      wav_bytes: wavPayload.length,
      call_control_id: callControlId,
      ...(opts.logContext ?? {}),
    });

    const wavSha1 = sha1Hex(wavPayload);
    const h10 = wavSha1.slice(0, 10);

    // Deduplicate identical partial payloads per call (use full sha1)
    if (!isFinal) {
      const prev = lastPartialSha1ByCall.get(safeCallKey);
      if (prev === wavSha1) {
        if (mediaDebugEnabled() || shouldTrace(callControlId)) {
          log.info(
            {
              event: 'stt_whisper_partial_dedup_skipped',
              call_control_id: callControlId,
              sha1_10: h10,
              ...(opts.logContext ?? {}),
            },
            'skipping duplicate partial whisper request',
          );
        }
        return { text: '', isFinal: false, raw: { skipped: 'dup_partial', sha1_10: h10 } };
      }
      lastPartialSha1ByCall.set(safeCallKey, wavSha1);
    }

    const whisperStage: 'partial' | 'final' = opts.isPartial ? 'partial' : 'final';
    const tenantLabel = typeof opts.logContext?.tenant_id === 'string' ? opts.logContext.tenant_id : 'unknown';
    const stageLabel = opts.isPartial ? 'stt_whisper_http_partial' : 'stt_whisper_http_final';

    const audioMs = computeAudioMs(audioForMetrics, wavPayload);
    observeStageDuration(opts.isPartial ? 'stt_payload_ms_partial' : 'stt_payload_ms_final', tenantLabel, audioMs);

    // Optional probing/dumps
    probeWav('stt.submit.wav', wavPayload, { ...wavMeta, kind: whisperStage });
    await maybeDumpWhisperWav(wavPayload, whisperStage, opts.logContext);

    // Trace + media debug summary
    if (mediaDebugEnabled()) logWavDebug(wavPayload, opts.logContext);

    if (shouldTrace(callControlId)) {
      const riff = wavPayload.length >= 12 ? wavPayload.toString('ascii', 0, 4) : '';
      const wave = wavPayload.length >= 12 ? wavPayload.toString('ascii', 8, 12) : '';
      log.info(
        {
          event: 'whisper_send',
          kind: whisperStage,
          endpoint: whisperUrl,
          wav_bytes: wavPayload.length,
          riff_ok: riff === 'RIFF',
          wave_ok: wave === 'WAVE',
          sha1_10: h10,
          audio_ms: Math.round(audioMs),
          ...(opts.logContext ?? {}),
        },
        'sending whisper wav',
      );
    } else if (mediaDebugEnabled()) {
      log.info(
        {
          event: 'whisper_request',
          kind: whisperStage,
          wav_bytes: wavPayload.length,
          sha1_10: h10,
          ...(opts.logContext ?? {}),
        },
        'whisper request',
      );
    }

    const end = startStageTimer(stageLabel, tenantLabel);
    let ended = false;
    const safeEnd = (): void => {
      if (!ended) {
        ended = true;
        end();
      }
    };

    const httpStartedAtMs = Date.now();

    // Abort listener needs to be removable in finally (scope-safe)
    let onAbort: (() => void) | undefined;

    try {
      // Send raw WAV bytes (curl --data-binary). Avoid multipart.
      if (shouldTrace(callControlId) || mediaDebugEnabled()) {
        log.info(
          {
            event: 'whisper_body_debug',
            wav_bytes: wavPayload.length,
            body_bytes: wavPayload.length,
            head12: wavPayload.toString('ascii', 0, 12),
            sha1_10: h10,
            ...(opts.logContext ?? {}),
          },
          'whisper body debug',
        );
      }

      // Normalize body to a Node Buffer (best compatibility with undici/fetch in Node)
      const body = Buffer.isBuffer(wavPayload) ? wavPayload : Buffer.from(wavPayload as unknown as Uint8Array);

      // ✅ DO NOT SKIP if the signal is already aborted.
      // In call systems, final STT frequently happens during teardown/hangup.
      if (opts.signal?.aborted) {
        log.warn(
          {
            event: 'whisper_signal_already_aborted_but_continuing',
            whisperUrl,
            bytes: body.length,
            sha1_10: h10,
            ...(opts.logContext ?? {}),
          },
          'signal already aborted, but continuing whisper request (not canceling HTTP)',
        );
      }

      // If aborted DURING request, DO NOT cancel fetch.
      // We log abort and may discard response after Whisper returns.
      onAbort = () => {
        log.warn(
          {
            event: 'whisper_abort_observed',
            whisperUrl,
            sha1_10: h10,
            ...(opts.logContext ?? {}),
          },
          'whisper abort observed while request may be in-flight (not canceling HTTP)',
        );
      };
      opts.signal?.addEventListener?.('abort', onAbort);

      log.info(
        {
          event: 'whisper_fetch_start',
          kind: whisperStage,
          whisperUrl,
          bytes: body.length,
          content_type: 'audio/wav',
          sha1_10: h10,
          ...(opts.logContext ?? {}),
        },
        'sending wav to whisper',
      );

      // IMPORTANT:
      // ✅ Do NOT pass opts.signal into fetch() (it will cancel the HTTP request).
      const response = await fetch(whisperUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': String(body.length), // explicit; harmless if ignored
          Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        },
        body: body as any,
      });

      const contentType = response.headers.get('content-type') ?? '';
      const respText = await response.text().catch(() => '');

      const httpMs = Date.now() - httpStartedAtMs;

      log.info(
        {
          event: 'whisper_fetch_done',
          kind: whisperStage,
          status: response.status,
          ok: response.ok,
          content_type: contentType,
          elapsed_ms: httpMs,
          body_preview: respText.slice(0, 500),
          sha1_10: h10,
          ...(opts.logContext ?? {}),
        },
        'whisper responded',
      );

      // If the call aborted while Whisper was working, discard result (don’t treat as failure)
      if (opts.signal?.aborted) {
        log.warn(
          {
            event: 'whisper_result_discarded_aborted',
            whisperUrl,
            elapsed_ms: httpMs,
            sha1_10: h10,
            ...(opts.logContext ?? {}),
          },
          'discarding whisper result because call aborted during request',
        );
        return { text: '', isFinal, raw: { discarded: true, reason: 'aborted_after_send' } };
      }

      if (!response.ok) {
        incStageError(stageLabel, tenantLabel);
        const preview = respText.length > 700 ? `${respText.slice(0, 700)}...` : respText;

        log.error(
          {
            event: 'whisper_error',
            status: response.status,
            kind: whisperStage,
            body_preview: preview,
            sha1_10: h10,
            ...(opts.logContext ?? {}),
          },
          'whisper request failed',
        );

        throw new Error(`whisper error ${response.status}: ${preview}`);
      }

      // --------------------------
      // Parse result (prefer JSON if possible, but handle text/plain)
      // --------------------------
      if (contentType.includes('application/json')) {
        let data: unknown;
        try {
          data = JSON.parse(respText);
        } catch {
          data = { text: '' };
        }

        const textOut = extractText(data);

        const transcript: STTTranscript = {
          text: textOut,
          isFinal,
          confidence:
            typeof (data as { confidence?: unknown })?.confidence === 'number'
              ? (data as { confidence?: number }).confidence
              : undefined,
          raw: data,
        };

        if (mediaDebugEnabled() || shouldTrace(callControlId)) {
          log.info(
            {
              event: 'whisper_response',
              status: response.status,
              kind: whisperStage,
              sha1_10: h10,
              transcript_length: transcript.text.length,
              transcript_preview: previewText(transcript.text),
              ...(opts.logContext ?? {}),
            },
            'whisper response',
          );
        }

        return transcript;
      }

      // text/plain fallback
      const textOut = respText ?? '';

      if (mediaDebugEnabled() || shouldTrace(callControlId)) {
        log.info(
          {
            event: 'whisper_response',
            status: response.status,
            kind: whisperStage,
            sha1_10: h10,
            transcript_length: textOut.length,
            transcript_preview: previewText(textOut),
            ...(opts.logContext ?? {}),
          },
          'whisper response',
        );
      }

      return { text: textOut, isFinal, raw: textOut };
    } catch (error) {
      if (!isAbortError(error)) incStageError(stageLabel, tenantLabel);
      throw error;
    } finally {
      // Always clean up listener + stage timer
      if (onAbort) opts.signal?.removeEventListener?.('abort', onAbort);
      safeEnd();
    }
  }
}
