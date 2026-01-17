"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugAudioTap = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
class DebugAudioTap {
    constructor(opts) {
        this.buffers = new Map();
        this.sizes = new Map();
        this.enabled = !!opts.enabled;
        this.baseDir = opts.baseDir;
        this.sessionId = opts.sessionId;
        this.sampleRate = opts.sampleRate;
        this.channels = opts.channels;
        // PCM16 bytes per second = sampleRate * channels * 2
        this.maxBytes = Math.max(1, Math.floor(opts.sampleRate * opts.channels * 2 * opts.secondsToKeep));
        if (this.enabled) {
            node_fs_1.default.mkdirSync(this.baseDir, { recursive: true });
        }
    }
    push(checkpoint, pcm16) {
        if (!this.enabled)
            return;
        if (!pcm16?.length)
            return;
        const arr = this.buffers.get(checkpoint) ?? [];
        const size = this.sizes.get(checkpoint) ?? 0;
        arr.push(pcm16);
        this.buffers.set(checkpoint, arr);
        this.sizes.set(checkpoint, size + pcm16.length);
        // Trim from front until within maxBytes
        this.trim(checkpoint);
    }
    flush(checkpoint, label) {
        if (!this.enabled)
            return;
        const arr = this.buffers.get(checkpoint);
        const size = this.sizes.get(checkpoint) ?? 0;
        if (!arr || size === 0)
            return;
        const pcm = Buffer.concat(arr, size);
        const wav = pcm16ToWav(pcm, this.sampleRate, this.channels);
        const filename = `${this.sessionId}__${checkpoint}__${Date.now()}__${sanitize(label)}.wav`;
        const outPath = node_path_1.default.join(this.baseDir, filename);
        node_fs_1.default.writeFileSync(outPath, wav);
        return outPath;
    }
    clear(checkpoint) {
        if (!checkpoint) {
            this.buffers.clear();
            this.sizes.clear();
            return;
        }
        this.buffers.delete(checkpoint);
        this.sizes.delete(checkpoint);
    }
    trim(checkpoint) {
        const arr = this.buffers.get(checkpoint);
        if (!arr)
            return;
        let size = this.sizes.get(checkpoint) ?? 0;
        while (size > this.maxBytes && arr.length > 1) {
            const head = arr.shift();
            if (!head)
                break;
            size -= head.length;
        }
        this.buffers.set(checkpoint, arr);
        this.sizes.set(checkpoint, size);
    }
}
exports.DebugAudioTap = DebugAudioTap;
function pcm16ToWav(pcm16, sampleRate, channels) {
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
    header.writeUInt32LE(16, 16); // PCM fmt chunk size
    header.writeUInt16LE(1, 20); // format = 1 (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm16]);
}
function sanitize(s) {
    return (s || "dump").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
}
//# sourceMappingURL=debugAudioTap.js.map