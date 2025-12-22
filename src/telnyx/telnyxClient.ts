import { env } from '../env';
import { log } from '../log';
import { TelnyxRequestOptions } from './types';

export interface TelnyxPreparedRequest {
  url: string;
  options: TelnyxRequestOptions & { headers: Record<string, string>; method: string };
}

export class TelnyxClient {
  private readonly apiKey = env.TELNYX_API_KEY;
  private readonly baseUrl = 'https://api.telnyx.com/v2';
  private readonly timeoutMs = 8000;
  private readonly maxRetries = 2;
  private readonly logContext: Record<string, unknown>;

  constructor(context: Record<string, unknown> = {}) {
    this.logContext = context;
  }

  public buildRequest(path: string, options: TelnyxRequestOptions = {}): TelnyxPreparedRequest {
    const url = new URL(path, this.baseUrl).toString();
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    return {
      url,
      options: {
        ...options,
        method: options.method ?? 'GET',
        headers,
      },
    };
  }

  public async request<T>(path: string, options: TelnyxRequestOptions = {}): Promise<T> {
    return this.requestWithRetry<T>(path, options, 0);
  }

  public async answerCall(callControlId: string): Promise<void> {
    await this.request<void>(`/calls/${callControlId}/actions/answer`, { method: 'POST' });
    log.info(
      { event: 'telnyx_answer_call', call_control_id: callControlId, ...this.logContext },
      'telnyx call answered',
    );
  }

  public async playAudio(callControlId: string, audioUrl: string): Promise<void> {
    await this.request<void>(`/calls/${callControlId}/actions/playback_start`, {
      method: 'POST',
      body: JSON.stringify({ audio_url: audioUrl }),
    });
    log.info(
      { event: 'telnyx_play_audio', call_control_id: callControlId, audio_url: audioUrl, ...this.logContext },
      'telnyx playback started',
    );
  }

  public async hangupCall(callControlId: string): Promise<void> {
    await this.request<void>(`/calls/${callControlId}/actions/hangup`, { method: 'POST' });
    log.info(
      { event: 'telnyx_hangup_call', call_control_id: callControlId, ...this.logContext },
      'telnyx call hangup',
    );
  }

  private async requestWithRetry<T>(
    path: string,
    options: TelnyxRequestOptions,
    attempt: number,
  ): Promise<T> {
    const prepared = this.buildRequest(path, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(prepared.url, {
        method: prepared.options.method,
        headers: prepared.options.headers,
        body: prepared.options.body,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        if (this.shouldRetry(response.status) && attempt < this.maxRetries) {
          log.warn(
            {
              event: 'telnyx_request_retry',
              url: prepared.url,
              status: response.status,
              attempt,
              duration_ms: durationMs,
              ...this.logContext,
            },
            'telnyx request retry',
          );
          return this.requestWithRetry<T>(path, options, attempt + 1);
        }

        log.error(
          {
            event: 'telnyx_request_failed',
            url: prepared.url,
            status: response.status,
            body,
            duration_ms: durationMs,
            ...this.logContext,
          },
          'telnyx request failed',
        );
        throw new Error(`Telnyx request failed: ${response.status}`);
      }

      log.info(
        {
          event: 'telnyx_request_completed',
          url: prepared.url,
          status: response.status,
          duration_ms: durationMs,
          ...this.logContext,
        },
        'telnyx request completed',
      );

      return body as T;
    } catch (error) {
      if (attempt < this.maxRetries) {
        log.warn(
          {
            event: 'telnyx_request_error_retry',
            url: prepared.url,
            attempt,
            err: error,
            ...this.logContext,
          },
          'telnyx request error retry',
        );
        return this.requestWithRetry<T>(path, options, attempt + 1);
      }

      log.error(
        { event: 'telnyx_request_error', url: prepared.url, err: error, ...this.logContext },
        'telnyx request error',
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }
}
