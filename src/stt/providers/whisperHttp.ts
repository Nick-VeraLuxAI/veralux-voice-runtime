import { env } from '../../env';
import { log } from '../../log';
import { observeStageDuration, startStageTimer, incStageError } from '../../metrics';
import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';
import type { AudioMeta } from '../../diagnostics/audioProbe';
import { appendLineage, probeWav } from '../../diagnostics/audioProbe';

const WAV_SAMPLE_RATE_HZ = 16000;
const PCM_8K_SAMPLE_RATE_HZ = 8000;

const wavDebugLogged = new Set<string>();
let wavDebugLoggedAnonymous = false;

const mediaDebugEnabled = (): boolean => {
  const value = process.env.MEDIA_DEBUG;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

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
  header.writeUInt16LE(1, 20);
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

function extractCallControlId(logContext?: Record<string, unknown>): string | undefined {
  const value = logContext?.call_control_id;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';

  const record = result as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.transcription === 'string') return record.transcription;

  return '';
}

function parseWavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

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

function prepareWavPayload(
  input: STTAudioInput,
  meta: AudioMeta | undefined,
): { wav: Buffer; meta: AudioMeta } {
  let nextMeta: AudioMeta = meta ?? {};
  if (input.encoding === 'wav') {
    nextMeta = appendLineage(nextMeta, 'passthrough:wav');
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
  if (!shouldLog) {
    return;
  }

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
      ...(logContext ?? {}),
    },
    'wav debug',
  );
}

export class WhisperHttpProvider implements STTProvider {
  public readonly id = 'whisper_http';
  public readonly supportsPartials = true;

  public async transcribe(audio: STTAudioInput, opts: STTOptions = {}): Promise<STTTranscript> {
    const baseUrl = opts.endpointUrl ?? process.env.WHISPER_URL ?? env.WHISPER_URL;
    if (!baseUrl) {
      throw new Error('WHISPER_URL is not set');
    }

    const whisperUrl = buildWhisperUrl(baseUrl, opts.language);
    const baseMeta: AudioMeta = {
      ...(opts.audioMeta ?? {}),
      logContext: opts.logContext ?? opts.audioMeta?.logContext,
      kind: opts.isPartial ? 'partial' : 'final',
    };
    const { wav: wavPayload, meta: wavMeta } = prepareWavPayload(audio, baseMeta);
    const audioMs = computeAudioMs(audio, wavPayload);
    const tenantLabel = typeof opts.logContext?.tenant_id === 'string' ? opts.logContext.tenant_id : 'unknown';
    const whisperStage = opts.isPartial ? 'partial' : 'final';
    const stageLabel = opts.isPartial ? 'stt_whisper_http_partial' : 'stt_whisper_http_final';

    observeStageDuration(
      opts.isPartial ? 'stt_payload_ms_partial' : 'stt_payload_ms_final',
      tenantLabel,
      audioMs,
    );

    probeWav('stt.submit.wav', wavPayload, {
      ...wavMeta,
      kind: whisperStage,
    });

    if (mediaDebugEnabled()) {
      logWavDebug(wavPayload, opts.logContext);
      log.info(
        {
          event: 'whisper_request',
          encoding: audio.encoding,
          wav_bytes: wavPayload.length,
        },
        'whisper request',
      );
    }

    const end = startStageTimer(stageLabel, tenantLabel);
    const httpStartedAt = Date.now();
    let response: Response;
    let httpMs = 0;
    try {
      response = await fetch(whisperUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
        },
        body: new Uint8Array(wavPayload),
        signal: opts.signal,
      });
      httpMs = Date.now() - httpStartedAt;
    } catch (error) {
      httpMs = Date.now() - httpStartedAt;
      log.info(
        {
          event: 'stt_whisper_request',
          tenant_id: tenantLabel,
          kind: whisperStage,
          whisper_stage: whisperStage,
          encoding: audio.encoding,
          sampleRateHz: audio.sampleRateHz,
          audio_bytes: wavPayload.length,
          audio_ms: audioMs,
          http_ms: httpMs,
          duration_ms: httpMs,
          ...(opts.logContext ?? {}),
        },
        'stt whisper request',
      );
      if (!isAbortError(error)) {
        incStageError(stageLabel, tenantLabel);
      }
      throw error;
    } finally {
      end();
    }

    log.info(
      {
        event: 'stt_whisper_request',
        tenant_id: tenantLabel,
        kind: whisperStage,
        whisper_stage: whisperStage,
        encoding: audio.encoding,
        sampleRateHz: audio.sampleRateHz,
        audio_bytes: wavPayload.length,
        audio_ms: audioMs,
        http_ms: httpMs,
        duration_ms: httpMs,
        ...(opts.logContext ?? {}),
      },
      'stt whisper request',
    );

    if (!response.ok) {
      const body = await response.text();
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;

      log.error(
        { event: 'whisper_error', status: response.status, body_preview: preview },
        'whisper request failed',
      );

      incStageError(stageLabel, tenantLabel);
      throw new Error(`whisper error ${response.status}: ${preview}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isFinal = !opts.isPartial;

    if (contentType.includes('application/json')) {
      const data = (await response.json()) as unknown;
      const transcript: STTTranscript = {
        text: extractText(data),
        isFinal,
        confidence:
          typeof (data as { confidence?: unknown }).confidence === 'number'
            ? (data as { confidence?: number }).confidence
            : undefined,
        raw: data,
      };

      if (mediaDebugEnabled()) {
        log.info(
          { event: 'whisper_response', status: response.status, transcript_length: transcript.text.length },
          'whisper response',
        );
      }

      return transcript;
    }

    const text = await response.text();

    if (mediaDebugEnabled()) {
      log.info(
        { event: 'whisper_response', status: response.status, transcript_length: text.length },
        'whisper response',
      );
    }

    return { text, isFinal, raw: text };
  }
}