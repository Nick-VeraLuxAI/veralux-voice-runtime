import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('telnyxVerify rejects missing signature', async () => {
  const { verifyTelnyxSignature } = await import('../src/telnyx/telnyxVerify');

  const result = verifyTelnyxSignature({
    rawBody: Buffer.from('{}'),
    signature: '',
    timestamp: Math.floor(Date.now() / 1000).toString(),
  });

  assert.deepEqual(result, { ok: false, skipped: false });
});