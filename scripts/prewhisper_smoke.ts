import fs from 'fs';
import path from 'path';
import { preWhisperGate, analyzePcm16 } from '../src/audio/preWhisperGate';
import { decodeWavToPcm16 } from '../src/audio/postprocess';

type Args = {
  file?: string;
  codec?: string;
  rate?: number;
  channels?: number;
  callId?: string;
  out?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--codec') {
      args.codec = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--rate') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed)) args.rate = parsed;
      i += 1;
      continue;
    }
    if (arg === '--channels') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed)) args.channels = parsed;
      i += 1;
      continue;
    }
    if (arg === '--callId') {
      args.callId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (!args.file) {
      args.file = arg;
    }
  }
  return args;
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.info(
    'Usage: tsx scripts/prewhisper_smoke.ts <file> [--codec pcm16le|pcmu|wav] [--rate 16000] [--channels 1] [--callId id] [--out out.wav]',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(args.file);
  const inputBuf = await fs.promises.readFile(inputPath);
  const callId = args.callId ?? 'prewhisper_smoke';

  const gate = await preWhisperGate({
    buf: inputBuf,
    hints: {
      codec: args.codec,
      sampleRate: args.rate,
      channels: args.channels,
      callId,
    },
  });

  const outPath = args.out ? path.resolve(args.out) : `${inputPath}.prewhisper.wav`;
  await fs.promises.writeFile(outPath, gate.wav16kMono);

  const decoded = decodeWavToPcm16(gate.wav16kMono);
  if (!decoded) {
    // eslint-disable-next-line no-console
    console.info(`Wrote ${outPath} (unable to decode wav for stats)`);
    return;
  }

  const stats = analyzePcm16(decoded.samples);
  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify(
      {
        out: outPath,
        sample_rate_hz: decoded.sampleRateHz,
        samples: decoded.samples.length,
        rms: Number(stats.rms.toFixed(6)),
        peak: Number(stats.peak.toFixed(6)),
        clipped: stats.clipped,
        dc_offset: Number(stats.dcOffsetApprox.toFixed(6)),
      },
      null,
      2,
    ),
  );
}

void main();
