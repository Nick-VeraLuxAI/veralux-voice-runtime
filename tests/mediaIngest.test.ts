import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('normalizeTelnyxTrack normalizes inbound/outbound variants', async () => {
  const { normalizeTelnyxTrack } = await import('../src/media/mediaIngest');

  assert.equal(normalizeTelnyxTrack('inbound_track'), 'inbound');
  assert.equal(normalizeTelnyxTrack('INBOUND'), 'inbound');
  assert.equal(normalizeTelnyxTrack('outbound_track'), 'outbound');
  assert.equal(normalizeTelnyxTrack('outbound'), 'outbound');
});

test('MediaIngestHealthMonitor flags low RMS early', async () => {
  const { MediaIngestHealthMonitor } = await import('../src/media/mediaIngest');

  const monitor = new MediaIngestHealthMonitor();
  const start = Date.now();
  monitor.start(start);

  for (let i = 0; i < 12; i += 1) {
    monitor.recordPayload(80, 80, 0.0001, 0.0002, true);
    monitor.recordEmittedChunk(0.0001, 0.0002);
  }

  const reason = monitor.evaluate(start + 1200);
  assert.equal(reason, 'low_rms');
});

test('resamplePcm16 doubles length from 8k to 16k', async () => {
  const { resamplePcm16 } = await import('../src/audio/codecDecode');

  const input = new Int16Array(80);
  input[0] = 1000;
  const output = resamplePcm16(input, 8000, 16000);

  assert.equal(output.length, input.length * 2);
});
