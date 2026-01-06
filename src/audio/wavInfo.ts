export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

export interface WavHeaderSummary {
  riff: boolean;
  wave: boolean;
  first16Hex: string;
}

function isRiffWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export function describeWavHeader(buffer: Buffer): WavHeaderSummary {
  const riff = buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF';
  const wave = buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE';
  const max = Math.min(buffer.length, 16);
  let hex = '';
  for (let i = 0; i < max; i += 1) {
    hex += buffer[i]!.toString(16).padStart(2, '0');
  }
  return { riff, wave, first16Hex: hex };
}

export function parseWavInfo(buffer: Buffer): WavInfo {
  if (!isRiffWav(buffer)) {
    throw new Error('invalid_riff_header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > buffer.length) {
        throw new Error('fmt_chunk_truncated');
      }
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkStart + paddedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
    throw new Error('missing_fmt_chunk');
  }
  if (dataBytes === null) {
    throw new Error('missing_data_chunk');
  }
  if (channels <= 0 || sampleRateHz <= 0 || bitsPerSample <= 0) {
    throw new Error('invalid_format_values');
  }

  const bytesPerSample = bitsPerSample / 8;
  const durationMs = (dataBytes / (sampleRateHz * channels * bytesPerSample)) * 1000;

  return {
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    dataBytes,
    durationMs,
  };
}