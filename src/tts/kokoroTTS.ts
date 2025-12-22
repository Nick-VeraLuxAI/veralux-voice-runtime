import { env } from '../env';
import { log } from '../log';
import { TTSRequest, TTSResult } from './types';

export async function synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
  const response = await fetch(env.KOKORO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: request.text,
      voice: request.voice,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body }, 'kokoro tts error');
    throw new Error(`kokoro tts error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? 'audio/wav',
  };
}
