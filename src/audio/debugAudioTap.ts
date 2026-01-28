import fs from "node:fs";
import path from "node:path";

type TapOpts = {
  baseDir: string;          // e.g. /tmp/veralux-audio
  sessionId: string;        // call/session id
  sampleRate: number;       // e.g. 16000
  channels: number;         // 1
  secondsToKeep: number;    // e.g. 8
  enabled: boolean;
};

export class DebugAudioTap {
  private readonly enabled: boolean;
  private readonly baseDir: string;
  private readonly sessionId: string;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly maxBytes: number;

  private buffers: Map<string, Buffer[]> = new Map();
  private sizes: Map<string, number> = new Map();

  constructor(opts: TapOpts) {
    this.enabled = !!opts.enabled;
    this.baseDir = opts.baseDir;
    this.sessionId = opts.sessionId;
    this.sampleRate = opts.sampleRate;
    this.channels = opts.channels;

    // PCM16 bytes per second = sampleRate * channels * 2
    this.maxBytes = Math.max(1, Math.floor(opts.sampleRate * opts.channels * 2 * opts.secondsToKeep));

    if (this.enabled) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  push(checkpoint: string, pcm16: Buffer) {
    if (!this.enabled) return;
    if (!pcm16?.length) return;

    const arr = this.buffers.get(checkpoint) ?? [];
    const size = this.sizes.get(checkpoint) ?? 0;

    arr.push(pcm16);
    this.buffers.set(checkpoint, arr);
    this.sizes.set(checkpoint, size + pcm16.length);

    // Trim from front until within maxBytes
    this.trim(checkpoint);
  }

  flush(checkpoint: string, label: string) {
    if (!this.enabled) return;
    const arr = this.buffers.get(checkpoint);
    const size = this.sizes.get(checkpoint) ?? 0;
    if (!arr || size === 0) return;

    const pcm = Buffer.concat(arr, size);
    const wav = pcm16ToWav(pcm, this.sampleRate, this.channels);

    const filename = `${this.sessionId}__${checkpoint}__${Date.now()}__${sanitize(label)}.wav`;
    const outPath = path.join(this.baseDir, filename);
    fs.writeFileSync(outPath, wav);

    return outPath;
  }

  clear(checkpoint?: string) {
    if (!checkpoint) {
      this.buffers.clear();
      this.sizes.clear();
      return;
    }
    this.buffers.delete(checkpoint);
    this.sizes.delete(checkpoint);
  }

  private trim(checkpoint: string) {
    const arr = this.buffers.get(checkpoint);
    if (!arr) return;

    let size = this.sizes.get(checkpoint) ?? 0;
    while (size > this.maxBytes && arr.length > 1) {
      const head = arr.shift();
      if (!head) break;
      size -= head.length;
    }
    this.buffers.set(checkpoint, arr);
    this.sizes.set(checkpoint, size);
  }
}

function pcm16ToWav(pcm16: Buffer, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const dataSize = pcm16.length;
  const riffSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);           // PCM fmt chunk size
  header.writeUInt16LE(1, 20);            // format = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);           // bits per sample

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16]);
}

function sanitize(s: string) {
  return (s || "dump").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
}
