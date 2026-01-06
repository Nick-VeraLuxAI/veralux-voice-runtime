import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('startStreaming uses allowed stream_track values', async () => {
  process.env.TELNYX_STREAM_TRACK = 'inbound_track';

  const { TelnyxClient } = await import('../src/telnyx/telnyxClient');
  const originalFetch = globalThis.fetch;

  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body as string | undefined });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ result: 'ok' }),
      text: async () => JSON.stringify({ result: 'ok' }),
    } as Response;
  };

  try {
    const client = new TelnyxClient();
    await client.startStreaming('call_123', 'wss://example.com/v1/telnyx/media/call_123?token=abc');

    assert.equal(calls.length, 1);
    const payload = calls[0].body ? (JSON.parse(calls[0].body) as Record<string, unknown>) : {};
    assert.equal(payload.stream_track, 'inbound_track');
  } finally {
    globalThis.fetch = originalFetch;
  }
});