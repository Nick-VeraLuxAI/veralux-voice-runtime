"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelnyxClient = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
class TelnyxClient {
    constructor(context = {}) {
        this.apiKey = env_1.env.TELNYX_API_KEY;
        this.baseUrl = 'https://api.telnyx.com/v2';
        this.timeoutMs = 8000;
        this.maxRetries = 2;
        this.logContext = context;
    }
    buildRequest(path, options = {}) {
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
    async request(path, options = {}) {
        return this.requestWithRetry(path, options, 0);
    }
    async answerCall(callControlId) {
        await this.request(`/calls/${callControlId}/actions/answer`, { method: 'POST' });
        log_1.log.info({ event: 'telnyx_answer_call', call_control_id: callControlId, ...this.logContext }, 'telnyx call answered');
    }
    async playAudio(callControlId, audioUrl) {
        await this.request(`/calls/${callControlId}/actions/playback_start`, {
            method: 'POST',
            body: JSON.stringify({ audio_url: audioUrl }),
        });
        log_1.log.info({ event: 'telnyx_play_audio', call_control_id: callControlId, audio_url: audioUrl, ...this.logContext }, 'telnyx playback started');
    }
    async hangupCall(callControlId) {
        await this.request(`/calls/${callControlId}/actions/hangup`, { method: 'POST' });
        log_1.log.info({ event: 'telnyx_hangup_call', call_control_id: callControlId, ...this.logContext }, 'telnyx call hangup');
    }
    async requestWithRetry(path, options, attempt) {
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
                    log_1.log.warn({
                        event: 'telnyx_request_retry',
                        url: prepared.url,
                        status: response.status,
                        attempt,
                        duration_ms: durationMs,
                        ...this.logContext,
                    }, 'telnyx request retry');
                    return this.requestWithRetry(path, options, attempt + 1);
                }
                log_1.log.error({
                    event: 'telnyx_request_failed',
                    url: prepared.url,
                    status: response.status,
                    body,
                    duration_ms: durationMs,
                    ...this.logContext,
                }, 'telnyx request failed');
                throw new Error(`Telnyx request failed: ${response.status}`);
            }
            log_1.log.info({
                event: 'telnyx_request_completed',
                url: prepared.url,
                status: response.status,
                duration_ms: durationMs,
                ...this.logContext,
            }, 'telnyx request completed');
            return body;
        }
        catch (error) {
            if (attempt < this.maxRetries) {
                log_1.log.warn({
                    event: 'telnyx_request_error_retry',
                    url: prepared.url,
                    attempt,
                    err: error,
                    ...this.logContext,
                }, 'telnyx request error retry');
                return this.requestWithRetry(path, options, attempt + 1);
            }
            log_1.log.error({ event: 'telnyx_request_error', url: prepared.url, err: error, ...this.logContext }, 'telnyx request error');
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    shouldRetry(status) {
        return status === 429 || status >= 500;
    }
}
exports.TelnyxClient = TelnyxClient;
//# sourceMappingURL=telnyxClient.js.map