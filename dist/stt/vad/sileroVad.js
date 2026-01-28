"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SileroVad = void 0;
// src/stt/vad/sileroVad.ts
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const ort = __importStar(require("onnxruntime-node"));
const DEFAULT_THRESHOLD = 0.5;
// Silero commonly expects 512 samples @ 16k (32ms).
const FRAME_SAMPLES_16K = 512;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_SR = 16000;
// Silero VAD recurrent state is almost always [2, 1, 128] float32
const DEFAULT_STATE_DIMS = [2, 1, 128];
function int16ToFloat32(i16) {
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i += 1)
        f32[i] = i16[i] / 32768;
    return f32;
}
function resolveDefaultModelPath() {
    return node_path_1.default.join(process.cwd(), 'src', 'stt', 'vad', 'models', 'silero_vad.onnx');
}
function isInt64TensorType(type) {
    return typeof type === 'string' && type.toLowerCase().includes('int64');
}
function buildMetaByName(names, metas) {
    const out = {};
    const n = Math.min(names.length, metas.length);
    for (let i = 0; i < n; i += 1) {
        const name = names[i];
        const meta = metas[i];
        if (name && meta)
            out[name] = meta;
    }
    return out;
}
function looksLikeStateInput(name) {
    const n = name.toLowerCase();
    return n === 'state' || n.includes('state') || n === 'h' || n === 'c' || n.endsWith('_h') || n.endsWith('_c');
}
function normalizeDims(dims) {
    const raw = dims ?? [];
    const out = raw.map((d) => (typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1));
    return out.length > 0 ? out : [1];
}
function makeZeroTensor(meta) {
    const dims = normalizeDims(meta.dimensions);
    const size = dims.reduce((a, b) => a * b, 1);
    return new ort.Tensor(meta.type, new Float32Array(size), dims);
}
/**
 * Critical fix:
 * Some ORT builds / exports don't provide dimensions for the recurrent state input.
 * If dims are missing or not rank-3, we force the canonical Silero state dims [2,1,128].
 */
function makeStateLikeTensor(meta) {
    const type = (meta.type ?? 'float32');
    const dims = normalizeDims(meta.dimensions);
    const rank3 = (dims.length === 3 ? dims : null) ??
        DEFAULT_STATE_DIMS;
    // If metadata gave rank-3 but it's basically unknown placeholders (all ones),
    // prefer the canonical Silero dims.
    const isAllOnes = rank3[0] === 1 && rank3[1] === 1 && rank3[2] === 1;
    const finalDims = isAllOnes ? DEFAULT_STATE_DIMS : rank3;
    const size = finalDims[0] * finalDims[1] * finalDims[2];
    return new ort.Tensor(type, new Float32Array(size), finalDims);
}
class SileroVad {
    static async create(opts = {}) {
        if (opts.sampleRateHz && opts.sampleRateHz !== DEFAULT_SR) {
            throw new Error(`Silero VAD only supports 16kHz. Got sampleRateHz=${opts.sampleRateHz}`);
        }
        const vad = new SileroVad(opts.threshold ?? DEFAULT_THRESHOLD);
        const modelPath = opts.modelPath ?? resolveDefaultModelPath();
        if (!node_fs_1.default.existsSync(modelPath)) {
            throw new Error(`Silero VAD model not found at ${modelPath}`);
        }
        vad.session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
        });
        // Cast to our local meta type (works across ORT typing versions)
        const inputMetas = vad.session.inputMetadata;
        vad.inputMetaByName = buildMetaByName(vad.session.inputNames, inputMetas);
        // Choose audio input tensor name (usually "input", sometimes "x")
        const inNames = vad.session.inputNames;
        const audioName = inNames.find((n) => n.toLowerCase() === 'input') ??
            inNames.find((n) => n.toLowerCase().includes('input')) ??
            inNames.find((n) => n.toLowerCase() === 'x') ??
            inNames[0];
        if (!audioName)
            throw new Error('Silero VAD: could not determine audio input name');
        vad.inputNameAudio = audioName;
        // Capture input dims so we can shape audio correctly ([1,T] vs [1,1,T])
        const audioMeta = vad.inputMetaByName[vad.inputNameAudio];
        vad.audioInputDims = audioMeta?.dimensions ?? [];
        // Choose probability output (usually "output", sometimes "y")
        const outNames = vad.session.outputNames;
        const outName = outNames.find((n) => n.toLowerCase() === 'output') ??
            outNames.find((n) => n.toLowerCase().includes('output')) ??
            outNames.find((n) => n.toLowerCase() === 'y') ??
            outNames[0];
        if (!outName)
            throw new Error('Silero VAD: could not determine output name');
        vad.outputNameProb = outName;
        vad.reset();
        return vad;
    }
    constructor(threshold) {
        // recurrent state + other non-audio inputs (sr, h/c, etc.)
        this.state = {};
        // raw PCM buffer until we have FRAME_SAMPLES_16K
        this.pcmBuf = Buffer.alloc(0);
        this.inputMetaByName = {};
        this.audioInputDims = [];
        // Serialize ORT calls (defensive: avoids concurrent session.run() issues)
        this.chain = Promise.resolve();
        this.threshold = threshold;
    }
    reset() {
        this.pcmBuf = Buffer.alloc(0);
        this.state = {};
        // initialize any non-audio inputs (h/c/sr/state, etc.) if present
        for (const name of this.session.inputNames) {
            if (name === this.inputNameAudio)
                continue;
            const meta = this.inputMetaByName[name];
            if (!meta)
                continue;
            // Special-case sample rate input if model expects sr as int64 or float
            if (name.toLowerCase().includes('sr')) {
                if (isInt64TensorType(meta.type)) {
                    this.state[name] = new ort.Tensor('int64', BigInt64Array.from([BigInt(DEFAULT_SR)]), [1]);
                }
                else {
                    this.state[name] = new ort.Tensor('float32', new Float32Array([DEFAULT_SR]), [1]);
                }
                continue;
            }
            // Critical: force recurrent inputs to be rank-3 even if metadata is missing
            if (looksLikeStateInput(name)) {
                this.state[name] = makeStateLikeTensor(meta);
                continue;
            }
            // Default: zero tensor for other inputs
            this.state[name] = makeZeroTensor(meta);
        }
    }
    /**
     * Feed PCM16LE mono @ 16kHz. Returns null until enough audio is buffered for one model frame.
     */
    async pushPcm16le16k(pcm16le) {
        if (!pcm16le || pcm16le.length === 0)
            return null;
        this.pcmBuf = Buffer.concat([this.pcmBuf, pcm16le]);
        const needBytes = FRAME_SAMPLES_16K * BYTES_PER_SAMPLE;
        if (this.pcmBuf.length < needBytes)
            return null;
        const frame = this.pcmBuf.subarray(0, needBytes);
        this.pcmBuf = this.pcmBuf.subarray(needBytes);
        // serialize the ORT run (defensive)
        this.chain = this.chain.then(() => this.runFrame(frame));
        return this.chain;
    }
    async runFrame(frame) {
        const i16 = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES_16K);
        const f32 = int16ToFloat32(i16);
        // Some Silero exports want [1,T], others want [1,1,T]
        const audioShape = this.audioInputDims.length === 3 ? [1, 1, f32.length] : [1, f32.length];
        const feeds = {
            ...this.state,
            [this.inputNameAudio]: new ort.Tensor('float32', f32, audioShape),
        };
        let out;
        try {
            out = (await this.session.run(feeds));
        }
        catch (err) {
            // Never allow VAD to crash the voice runtime.
            // Choose the behavior you prefer: permissive (true) or conservative (false).
            return { prob: 1, isSpeech: true };
        }
        // read prob from output tensor
        const probTensor = out[this.outputNameProb];
        if (!probTensor) {
            throw new Error(`Silero VAD: missing output ${this.outputNameProb}`);
        }
        const data = probTensor.data;
        const prob = Number(data?.[0] ?? 0);
        // Robust recurrent-state update:
        // 1) If the model produced a tensor whose name is also an input name (and is not audio), keep it.
        for (const name of this.session.inputNames) {
            if (name === this.inputNameAudio)
                continue;
            const produced = out[name];
            if (produced)
                this.state[name] = produced;
        }
        // 2) Also accept common alt output names for state
        for (const [k, v] of Object.entries(out)) {
            if (k === this.outputNameProb)
                continue;
            if (k === this.inputNameAudio)
                continue;
            if (looksLikeStateInput(k))
                this.state[k] = v;
        }
        const isSpeech = prob >= this.threshold;
        return { prob, isSpeech };
    }
}
exports.SileroVad = SileroVad;
//# sourceMappingURL=sileroVad.js.map