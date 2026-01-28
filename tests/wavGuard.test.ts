import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLooksLikeWav } from '../src/stt/wavGuard';
import { encodePcm16ToWav } from '../src/audio/postprocess';

test('assertLooksLikeWav accepts a valid WAV header', () => {
  const samples = new Int16Array([0, 100, -100, 50]);
  const wav = encodePcm16ToWav(samples, 16000);
  assert.doesNotThrow(() => assertLooksLikeWav(wav, { test: true }));
});

test('assertLooksLikeWav rejects non-WAV payload', () => {
  const raw = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  assert.throws(() => assertLooksLikeWav(raw, { test: true }), /invalid_wav_payload/);
});
