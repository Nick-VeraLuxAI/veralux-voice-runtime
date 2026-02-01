"use strict";
// src/audio/inboundRingBuffer.ts
// Lightweight PCM16 ring buffer for pre-roll snapshots.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InboundPcm16RingBuffer = void 0;
class InboundPcm16RingBuffer {
    constructor(options) {
        this.frames = [];
        this.totalMs = 0;
        this.sampleRateHz = Math.max(1, Math.floor(options.sampleRateHz));
        this.maxMs = Math.max(1, Math.floor(options.maxMs));
    }
    push(pcm16, sampleRateHz) {
        if (!pcm16 || pcm16.length === 0)
            return;
        if (sampleRateHz !== this.sampleRateHz)
            return;
        const frameMs = (pcm16.length / sampleRateHz) * 1000;
        if (!Number.isFinite(frameMs) || frameMs <= 0)
            return;
        const view = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        const buffer = Buffer.from(view);
        this.frames.push({ buffer, ms: frameMs });
        this.totalMs += frameMs;
        while (this.totalMs > this.maxMs && this.frames.length > 0) {
            const dropped = this.frames.shift();
            if (!dropped)
                break;
            this.totalMs -= dropped.ms;
        }
    }
    snapshot() {
        const frames = this.frames.map((frame) => ({ buffer: frame.buffer, ms: frame.ms }));
        return {
            frames,
            totalMs: this.totalMs,
            sampleRateHz: this.sampleRateHz,
        };
    }
    reset() {
        this.frames = [];
        this.totalMs = 0;
    }
}
exports.InboundPcm16RingBuffer = InboundPcm16RingBuffer;
//# sourceMappingURL=inboundRingBuffer.js.map