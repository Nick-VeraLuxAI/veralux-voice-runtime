import fs from 'fs/promises';
import path from 'path';
import { decodeTelnyxPayloadToPcm16, closeTelnyxCodecState, type TelnyxCodecState } from '../src/audio/codecDecode';
import { encodePcm16ToWav } from '../src/audio/postprocess';

type Args = {
  ndjson?: string;
  b64?: string;
  out?: string;
  report?: string;
  dumpFrames?: boolean;
  noStream?: boolean;
  maxFrames?: number;
  targetSampleRateHz?: number;
  encoding?: string;
};

type PayloadEntry = {
  buffer: Buffer;
  seq?: number;
  callControlId?: string;
  source: string;
};

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function looksLikeBase64(payload: string): boolean {
  const trimmed = payload.trim().replace(/=+$/, '');
  if (trimmed.length < 8) return false;
  return /^[A-Za-z0-9+/_-]+$/.test(trimmed);
}

function decodeBase64(payload: string): Buffer {
  let trimmed = payload.trim();
  const useBase64Url = trimmed.includes('-') || trimmed.includes('_');
  const encoding: BufferEncoding = useBase64Url ? 'base64url' : 'base64';
  const mod = trimmed.length % 4;
  if (mod !== 0) trimmed += '='.repeat(4 - mod);
  return Buffer.from(trimmed, encoding);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--ndjson') {
      args.ndjson = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--ndjson=')) {
      args.ndjson = arg.slice('--ndjson='.length);
      continue;
    }
    if (arg === '--b64') {
      args.b64 = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--b64=')) {
      args.b64 = arg.slice('--b64='.length);
      continue;
    }
    if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
      continue;
    }
    if (arg === '--report') {
      args.report = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--report=')) {
      args.report = arg.slice('--report='.length);
      continue;
    }
    if (arg === '--dump-frames') {
      args.dumpFrames = true;
      continue;
    }
    if (arg === '--no-stream') {
      args.noStream = true;
      continue;
    }
    if (arg === '--max-frames') {
      args.maxFrames = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-frames=')) {
      args.maxFrames = Number(arg.slice('--max-frames='.length));
      continue;
    }
    if (arg === '--target-rate') {
      args.targetSampleRateHz = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--target-rate=')) {
      args.targetSampleRateHz = Number(arg.slice('--target-rate='.length));
      continue;
    }
    if (arg === '--encoding') {
      args.encoding = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--encoding=')) {
      args.encoding = arg.slice('--encoding='.length);
    }
  }
  return args;
}

function extractPayloadString(record: Record<string, unknown>): string | null {
  const media = record.media as Record<string, unknown> | undefined;
  const mediaData = media?.data as Record<string, unknown> | undefined;
  const message = record.message as Record<string, unknown> | undefined;
  const messageMedia = message?.media as Record<string, unknown> | undefined;
  const messageMediaData = messageMedia?.data as Record<string, unknown> | undefined;

  const candidates: Array<unknown> = [
    record.payload,
    record.payload_base64,
    media?.payload,
    media?.data,
    mediaData?.payload,
    message?.payload,
    messageMedia?.payload,
    messageMedia?.data,
    messageMediaData?.payload,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && looksLikeBase64(candidate)) return candidate;
  }
  return null;
}

function computePcmStats(samples: Int16Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = (samples[i] ?? 0) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSquares += s * s;
  }
  return { rms: Math.sqrt(sumSquares / samples.length), peak };
}

function countZeroSamples(samples: Int16Array): number {
  let count = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i] === 0) count += 1;
  }
  return count;
}

async function loadNdjsonPayloads(ndjsonPath: string): Promise<PayloadEntry[]> {
  const text = await fs.readFile(ndjsonPath, 'utf8');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const baseDir = path.dirname(ndjsonPath);
  const pending: Array<{ seq?: number; callControlId?: string }> = [];
  const payloads: PayloadEntry[] = [];

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payloadStr = extractPayloadString(record);
    const seq = typeof record.seq === 'number' ? record.seq : undefined;
    const callControlId =
      typeof record.call_control_id === 'string' ? record.call_control_id : undefined;

    if (payloadStr) {
      payloads.push({
        buffer: decodeBase64(payloadStr),
        seq,
        callControlId,
        source: 'ndjson',
      });
      continue;
    }

    if (seq !== undefined || callControlId) {
      pending.push({ seq, callControlId });
    }
  }

  if (pending.length === 0) return payloads;

  const entries = await fs.readdir(baseDir);
  const captureMap = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.endsWith('.raw.bin')) continue;
    if (!entry.startsWith('capture_')) continue;
    const match = entry.match(/^capture_(.+)_(\d+)_\d+\.raw\.bin$/);
    if (!match) continue;
    const callId = match[1];
    const seq = match[2];
    captureMap.set(`${callId}:${seq}`, path.join(baseDir, entry));
  }

  for (const item of pending) {
    if (!item.callControlId || item.seq === undefined) continue;
    const key = `${item.callControlId}:${item.seq}`;
    const filePath = captureMap.get(key);
    if (!filePath) continue;
    const buffer = await fs.readFile(filePath);
    payloads.push({
      buffer,
      seq: item.seq,
      callControlId: item.callControlId,
      source: 'raw_bin',
    });
  }

  return payloads;
}

async function loadBase64Payloads(filePath: string): Promise<PayloadEntry[]> {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const payloads: PayloadEntry[] = [];
  for (const line of lines) {
    if (!looksLikeBase64(line)) continue;
    payloads.push({ buffer: decodeBase64(line), source: 'b64_file' });
  }
  return payloads;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out ?? '/tmp/amrwb_replay.wav';
  const reportPath = args.report ?? `${outPath}.json`;
  const targetRate = Number.isFinite(args.targetSampleRateHz ?? 0) ? (args.targetSampleRateHz as number) : 16000;
  const encoding = args.encoding ?? 'AMR-WB';
  const verbose = parseBoolEnv(process.env.AMRWB_REPLAY_REPORT);

  if (!args.ndjson && !args.b64) {
    console.error(
      'Usage: tsx scripts/amrwb_replay_capture.ts --ndjson /path/to/telnyx_media_capture.ndjson [--out /tmp/replay.wav] [--report /tmp/replay.json]',
    );
    console.error(
      '   or: tsx scripts/amrwb_replay_capture.ts --b64 /path/to/payloads.b64 [--out /tmp/replay.wav]',
    );
    process.exit(1);
  }

  let payloads: PayloadEntry[] = [];
  if (args.ndjson) {
    payloads = payloads.concat(await loadNdjsonPayloads(args.ndjson));
  }
  if (args.b64) {
    payloads = payloads.concat(await loadBase64Payloads(args.b64));
  }

  if (payloads.length === 0) {
    console.error('No payloads found to replay.');
    process.exit(1);
  }

  const state: TelnyxCodecState = {};
  if (args.noStream) state.amrwbFfmpegStreamDisabled = true;

  const report: Array<Record<string, unknown>> = [];
  const pcmChunks: Int16Array[] = [];
  let totalSamples = 0;

  const maxFrames = Number.isFinite(args.maxFrames ?? 0) ? (args.maxFrames as number) : payloads.length;
  const limit = Math.min(payloads.length, maxFrames);

  const framesDir = args.dumpFrames ? path.join(path.dirname(outPath), 'amrwb_frames') : null;
  if (framesDir) {
    await fs.mkdir(framesDir, { recursive: true });
  }

  for (let i = 0; i < limit; i += 1) {
    const entry = payloads[i];
    const decoded = await decodeTelnyxPayloadToPcm16({
      encoding,
      payload: entry.buffer,
      channels: 1,
      reportedSampleRateHz: targetRate,
      targetSampleRateHz: targetRate,
      allowAmrWb: true,
      allowG722: false,
      allowOpus: false,
      state,
      logContext: {
        replay: true,
        frame_index: i,
        seq: entry?.seq,
        call_control_id: entry?.callControlId,
      },
    });

    const pcm16 = decoded?.pcm16 ?? new Int16Array(0);
    const stats = computePcmStats(pcm16);
    const zeroCount = countZeroSamples(pcm16);
    const zeroRatio = pcm16.length > 0 ? zeroCount / pcm16.length : 1;

    report.push({
      index: i,
      seq: entry?.seq ?? null,
      call_control_id: entry?.callControlId ?? null,
      payload_len: entry.buffer.length,
      source: entry.source,
      decode_ok: Boolean(decoded),
      pcm_len: pcm16.length,
      rms: Number(stats.rms.toFixed(6)),
      peak: Number(stats.peak.toFixed(6)),
      zero_ratio: Number(zeroRatio.toFixed(6)),
      zero_samples: zeroCount,
    });

    if (verbose) {
      console.log(
        [
          `frame=${i}`,
          `seq=${entry?.seq ?? 'n/a'}`,
          `payload=${entry.buffer.length}`,
          `pcm=${pcm16.length}`,
          `rms=${stats.rms.toFixed(6)}`,
          `zero_ratio=${zeroRatio.toFixed(3)}`,
        ].join(' '),
      );
    }

    if (pcm16.length > 0) {
      pcmChunks.push(pcm16);
      totalSamples += pcm16.length;
      if (framesDir) {
        const name = `frame_${String(i).padStart(5, '0')}_seq_${entry?.seq ?? 'na'}.pcm`;
        const out = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        await fs.writeFile(path.join(framesDir, name), out);
      }
    }
  }

  const combined = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of pcmChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const wav = encodePcm16ToWav(combined, targetRate);
  await fs.writeFile(outPath, wav);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  closeTelnyxCodecState(state);

  console.log(`replay wav: ${outPath}`);
  console.log(`report: ${reportPath}`);
  if (framesDir) {
    console.log(`frames dir: ${framesDir}`);
  }
}

void main();
