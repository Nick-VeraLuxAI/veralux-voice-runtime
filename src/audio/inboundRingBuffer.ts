// src/audio/inboundRingBuffer.ts
// Lightweight PCM16 ring buffer for pre-roll snapshots.

export type Pcm16FrameSnapshot = {
  buffer: Buffer;
  ms: number;
};

export type Pcm16RingSnapshot = {
  frames: Pcm16FrameSnapshot[];
  totalMs: number;
  sampleRateHz: number;
};

export class InboundPcm16RingBuffer {
  private readonly sampleRateHz: number;
  private readonly maxMs: number;
  private frames: Pcm16FrameSnapshot[] = [];
  private totalMs = 0;

  constructor(options: { sampleRateHz: number; maxMs: number }) {
    this.sampleRateHz = Math.max(1, Math.floor(options.sampleRateHz));
    this.maxMs = Math.max(1, Math.floor(options.maxMs));
  }

  public push(pcm16: Int16Array, sampleRateHz: number): void {
    if (!pcm16 || pcm16.length === 0) return;
    if (sampleRateHz !== this.sampleRateHz) return;

    const frameMs = (pcm16.length / sampleRateHz) * 1000;
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;

    const view = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const buffer = Buffer.from(view);

    this.frames.push({ buffer, ms: frameMs });
    this.totalMs += frameMs;

    while (this.totalMs > this.maxMs && this.frames.length > 0) {
      const dropped = this.frames.shift();
      if (!dropped) break;
      this.totalMs -= dropped.ms;
    }
  }

  public snapshot(): Pcm16RingSnapshot {
    const frames = this.frames.map((frame) => ({ buffer: frame.buffer, ms: frame.ms }));
    return {
      frames,
      totalMs: this.totalMs,
      sampleRateHz: this.sampleRateHz,
    };
  }

  public reset(): void {
    this.frames = [];
    this.totalMs = 0;
  }
}
