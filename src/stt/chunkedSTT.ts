import { env } from '../env';
import { log } from '../log';
import { ChunkedSTTConfig, STTRequest, STTResult } from './types';

const DEFAULT_MIN_BYTES = 3200;

export interface ChunkedSTTOptions extends ChunkedSTTConfig {
  onTranscript: (text: string) => void | Promise<void>;
  logContext?: Record<string, unknown>;
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '';
  }

  const record = result as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }

  if (typeof record.transcription === 'string') {
    return record.transcription;
  }

  return '';
}

export async function transcribeChunk(request: STTRequest): Promise<STTResult> {
  const response = await fetch(env.WHISPER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: request.audio,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`whisper error ${response.status}: ${body}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as unknown;
    return {
      text: extractText(data),
      confidence:
        typeof (data as { confidence?: unknown }).confidence === 'number'
          ? (data as { confidence?: number }).confidence
          : undefined,
    };
  }

  const text = await response.text();
  return { text };
}

export class ChunkedSTT {
  private readonly chunkMs: number;
  private readonly silenceMs: number;
  private readonly minBytes: number;
  private readonly onTranscript: (text: string) => void | Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private readonly buffer: Buffer[] = [];
  private bufferBytes = 0;
  private silenceTimer?: NodeJS.Timeout;
  private flushQueue: Promise<void> = Promise.resolve();
  private readonly logContext?: Record<string, unknown>;

  constructor(options: ChunkedSTTOptions) {
    this.chunkMs = options.chunkMs;
    this.silenceMs = options.silenceMs;
    this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    this.onTranscript = options.onTranscript;
    this.logContext = options.logContext;

    this.timer = setInterval(() => {
      this.flushIfReady('interval');
    }, this.chunkMs);
    this.timer.unref?.();
  }

  public ingest(frame: Buffer): void {
    if (!frame || frame.length === 0) {
      return;
    }

    this.buffer.push(frame);
    this.bufferBytes += frame.length;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }

    this.silenceTimer = setTimeout(() => {
      this.flushIfReady('silence');
    }, this.silenceMs);
    this.silenceTimer.unref?.();
  }

  public stop(): void {
    clearInterval(this.timer);
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
  }

  private flushIfReady(reason: 'interval' | 'silence'): void {
    if (this.bufferBytes === 0) {
      return;
    }

    if (reason === 'interval' && this.bufferBytes < this.minBytes) {
      return;
    }

    const payload = Buffer.concat(this.buffer, this.bufferBytes);
    this.buffer.length = 0;
    this.bufferBytes = 0;

    this.flushQueue = this.flushQueue
      .then(async () => {
        const startedAt = Date.now();
        const result = await transcribeChunk({ audio: payload });
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

        if (text === '') {
          return;
        }

        await this.onTranscript(text);
      })
      .catch((error: unknown) => {
        log.error(
          { err: error, reason, ...(this.logContext ?? {}) },
          'stt chunk transcription failed',
        );
      });
  }
}
