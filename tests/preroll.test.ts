import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { STTAudioInput, STTProvider } from '../src/stt/chunkedSTT';
import { setTestEnv } from './testEnv';

setTestEnv();

test('ChunkedSTT prepends external pre-roll on speech start', async () => {
  const prevRxGuard = process.env.STT_RX_POSTPROCESS_ENABLED;
  const prevRxWindow = process.env.STT_RX_DEDUPE_WINDOW;
  const prevVad = process.env.STT_VAD_ENABLED;
  process.env.STT_RX_POSTPROCESS_ENABLED = 'false';
  process.env.STT_RX_DEDUPE_WINDOW = '0';
  process.env.STT_VAD_ENABLED = 'false';

  try {
    const { ChunkedSTT } = await import('../src/stt/chunkedSTT');

    const sampleRate = 16000;
    const preRollSamples = new Int16Array([100, 200, -300, 400, -500, 600, -700, 800]);
    const preRollBuffer = Buffer.from(
      preRollSamples.buffer,
      preRollSamples.byteOffset,
      preRollSamples.byteLength,
    );
    const preRollMs = (preRollSamples.length / sampleRate) * 1000;

    let resolveTranscribe: (input: STTAudioInput) => void;
    const transcribed = new Promise<STTAudioInput>((resolve) => {
      resolveTranscribe = resolve;
    });

    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async (input) => {
        resolveTranscribe(input);
        return { text: 'ok' };
      },
    };

    let consumed = false;
    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate,
      speechFramesRequired: 1,
      preRollMs: 0,
      consumePreRoll: () => {
        if (consumed) return null;
        consumed = true;
        return {
          frames: [{ buffer: Buffer.from(preRollBuffer), ms: preRollMs }],
          totalMs: preRollMs,
          sampleRateHz: sampleRate,
        };
      },
      onTranscript: () => undefined,
      isCallActive: () => true,
    });

    const speechSamples = new Int16Array(Math.round(sampleRate * 0.3)).fill(12000);
    stt.ingestPcm16(speechSamples, sampleRate);
    stt.ingestPcm16(speechSamples, sampleRate);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stt.stop();

    const input = await Promise.race([
      transcribed,
      new Promise<STTAudioInput>((_, reject) =>
        setTimeout(() => reject(new Error('transcribe_timeout')), 2000),
      ),
    ]);

    const prefix = input.audio.subarray(0, preRollBuffer.length);
    assert.ok(prefix.equals(preRollBuffer));
  } finally {
    if (prevRxGuard === undefined) delete process.env.STT_RX_POSTPROCESS_ENABLED;
    else process.env.STT_RX_POSTPROCESS_ENABLED = prevRxGuard;
    if (prevRxWindow === undefined) delete process.env.STT_RX_DEDUPE_WINDOW;
    else process.env.STT_RX_DEDUPE_WINDOW = prevRxWindow;
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
  }
});
