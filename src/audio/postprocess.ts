const TARGET_PEAK = 0.89 * 32767; // -1 dBFS
const HPF_CUTOFF_HZ = 100;
const DEFAULT_SAMPLE_RATE_HZ = 16000;
const SOFT_LIMIT_THRESHOLD = 0.9;
const OUTPUT_SAMPLE_RATE_HZ = 16000;
const MIN_PEAK_FOR_GAIN = 500;
const MAX_POSTPROCESS_GAIN = 10;

export interface PostprocessResult {
  audio: Buffer;
  gain: number;
  inputSampleRateHz: number;
  outputSampleRateHz: number;
  inputSamples: number;
  outputSamples: number;
  resampleMs: number;
  resampled: boolean;
}

export interface Pcm16Data {
  samples: Int16Array;
  sampleRateHz: number;
}

function clampInt16(n: number): number {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
}

function isWavBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
}

function softLimit(sample: number): number {
  const abs = Math.abs(sample);
  if (abs <= SOFT_LIMIT_THRESHOLD) return sample;
  const range = 1 - SOFT_LIMIT_THRESHOLD;
  if (range <= 0) return Math.sign(sample);
  const excess = abs - SOFT_LIMIT_THRESHOLD;
  const softened = SOFT_LIMIT_THRESHOLD + range * (1 - Math.exp(-excess / range));
  return Math.sign(sample) * softened;
}

function resamplePcm16Linear(
  samples: Int16Array,
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): Int16Array {
  if (samples.length === 0) return samples;
  if (inputSampleRateHz <= 0 || outputSampleRateHz <= 0) return samples;
  if (inputSampleRateHz === outputSampleRateHz) return samples;

  const outputLength = Math.max(
    1,
    Math.round(samples.length * (outputSampleRateHz / inputSampleRateHz)),
  );
  const output = new Int16Array(outputLength);

  const ratio = inputSampleRateHz / outputSampleRateHz;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const nextIndex = Math.min(index + 1, samples.length - 1);
    const frac = position - index;
    const s0 = samples[index] ?? 0;
    const s1 = samples[nextIndex] ?? s0;
    const mixed = s0 + (s1 - s0) * frac;
    output[i] = clampInt16(Math.round(mixed));
  }

  return output;
}

function wavHeader(pcmDataBytes: number, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

export function decodeWavToPcm16(wav: Buffer): Pcm16Data | null {
  if (!isWavBuffer(wav) || wav.length < 44) {
    return null;
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > wav.length) {
        return null;
      }
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRateHz = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkStart + paddedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || dataOffset === 0 || dataSize === 0) {
    return null;
  }

  const bytesPerSample = 2;
  const bytesPerFrame = bytesPerSample * Math.max(1, channels);
  const availableBytes = Math.min(dataSize, Math.max(0, wav.length - dataOffset));
  const frameCount = Math.floor(availableBytes / bytesPerFrame);
  if (frameCount <= 0) {
    return null;
  }

  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < Math.max(1, channels); ch += 1) {
      const sampleOffset = dataOffset + i * bytesPerFrame + ch * bytesPerSample;
      if (sampleOffset + 2 > wav.length) {
        break;
      }
      sum += wav.readInt16LE(sampleOffset);
    }
    const avg = sum / Math.max(1, channels);
    samples[i] = clampInt16(Math.round(avg));
  }

  return { samples, sampleRateHz: sampleRateHz || DEFAULT_SAMPLE_RATE_HZ };
}

export function encodePcm16ToWav(samples: Int16Array, sampleRateHz: number): Buffer {
  const pcmBuffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    pcmBuffer.writeInt16LE(samples[i], i * 2);
  }
  const header = wavHeader(pcmBuffer.length, sampleRateHz, 1);
  return Buffer.concat([header, pcmBuffer]);
}

export function postprocessPcm16(
  samples: Int16Array,
  sampleRateHz: number,
): { samples: Int16Array; gain: number } {
  if (samples.length === 0) {
    return { samples, gain: 1 };
  }

  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }

  let gain = 1;
  if (peak > 0) {
    const targetGain = TARGET_PEAK / peak;
    if (targetGain < 1) {
      gain = targetGain;
    } else {
      // Allow boosting even when the signal is quiet (but non-zero)
      gain = Math.min(targetGain, MAX_POSTPROCESS_GAIN);
    }
  }
  const sr = sampleRateHz > 0 ? sampleRateHz : DEFAULT_SAMPLE_RATE_HZ;
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * HPF_CUTOFF_HZ);
  const alpha = rc / (rc + dt);

  let prevIn = 0;
  let prevOut = 0;
  const output = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i += 1) {
    const scaled = (samples[i] * gain) / 32768;
    const filtered = alpha * (prevOut + scaled - prevIn);
    prevIn = scaled;
    prevOut = filtered;
    const limited = softLimit(filtered);
    output[i] = clampInt16(Math.round(limited * 32767));
  }

  return { samples: output, gain };
}

export function postprocessTtsAudio(
  audio: Buffer,
  options: { contentType?: string; sampleRateHz?: number },
): PostprocessResult | null {
  const contentType = options.contentType ?? '';
  const treatAsWav = contentType.includes('wav') || isWavBuffer(audio);

  let inputSamples: Int16Array | null = null;
  let inputSampleRateHz = 0;
  if (treatAsWav) {
    const decoded = decodeWavToPcm16(audio);
    if (!decoded) {
      return null;
    }
    inputSamples = decoded.samples;
    inputSampleRateHz = decoded.sampleRateHz;
  } else {
    inputSampleRateHz = options.sampleRateHz && options.sampleRateHz > 0
      ? options.sampleRateHz
      : DEFAULT_SAMPLE_RATE_HZ;
    const sampleCount = Math.floor(audio.length / 2);
    if (sampleCount <= 0) {
      return null;
    }
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = audio.readInt16LE(i * 2);
    }
    inputSamples = samples;
  }

  if (!inputSamples || inputSamples.length === 0) {
    return null;
  }

  const resampled = inputSampleRateHz !== OUTPUT_SAMPLE_RATE_HZ;
  let resampleMs = 0;
  const resampledSamples = (() => {
    if (!resampled) {
      return inputSamples;
    }
    const resampleStart = Date.now();
    const output = resamplePcm16Linear(
      inputSamples,
      inputSampleRateHz,
      OUTPUT_SAMPLE_RATE_HZ,
    );
    resampleMs = Date.now() - resampleStart;
    return output;
  })();
  const processed = postprocessPcm16(resampledSamples, OUTPUT_SAMPLE_RATE_HZ);

  return {
    audio: encodePcm16ToWav(processed.samples, OUTPUT_SAMPLE_RATE_HZ),
    gain: processed.gain,
    inputSampleRateHz,
    outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
    inputSamples: inputSamples.length,
    outputSamples: resampledSamples.length,
    resampleMs,
    resampled,
  };
}
