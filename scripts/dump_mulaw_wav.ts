import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_BASE64 =
  '/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////w==';

function muLawToPcmSample(u: number): number {
  const BIAS = 0x84;
  const muLawByte = (~u) & 0xff;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= BIAS;
  return sign ? -sample : sample;
}

function muLawBufferToPcm16LE(muLaw: Buffer): Buffer {
  const output = Buffer.alloc(muLaw.length * 2);
  for (let i = 0; i < muLaw.length; i += 1) {
    const sample = muLawToPcmSample(muLaw[i]);
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

function wavHeader(pcmDataBytes: number, sampleRate: number, numChannels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function makeWavFromMuLaw8k(muLaw: Buffer): Buffer {
  const pcm16le8k = muLawBufferToPcm16LE(muLaw);
  const header = wavHeader(pcm16le8k.length, 8000, 1);
  return Buffer.concat([header, pcm16le8k]);
}

const muLaw = Buffer.from(SAMPLE_BASE64, 'base64');
const wav = makeWavFromMuLaw8k(muLaw);
const outputPath = path.join('/tmp', 'telnyx_dump.wav');
fs.writeFileSync(outputPath, wav);

const isRiff = wav.subarray(0, 4).toString('ascii') === 'RIFF';
process.stdout.write(`wrote ${outputPath}\n`);
process.stdout.write(`riff=${isRiff}\n`);
