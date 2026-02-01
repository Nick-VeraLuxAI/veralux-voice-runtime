import { log } from '../log';

export function looksLikeWav(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

export function assertLooksLikeWav(buf: Buffer, context: Record<string, unknown> = {}): void {
  if (looksLikeWav(buf)) return;

  const firstBytesHex = buf.subarray(0, 32).toString('hex');
  log.error(
    {
      event: 'stt_invalid_wav_payload',
      buf_len: buf.length,
      first_bytes_hex: firstBytesHex,
      ...context,
    },
    'invalid wav payload',
  );
  throw new Error('invalid_wav_payload');
}
