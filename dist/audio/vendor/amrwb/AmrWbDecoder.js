"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmrWbDecoder = void 0;
const path_1 = __importDefault(require("path"));
const amrwb_js_1 = __importDefault(require("./amrwb.js"));
const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;
// IMPORTANT: tsx + CJS runtime → __dirname is valid
const wasmDir = __dirname;
let modulePromise = null;
async function loadModule() {
    if (!modulePromise) {
        const wasmPath = path_1.default.join(wasmDir, "amrwb.wasm");
        modulePromise = (0, amrwb_js_1.default)({
            locateFile: (file) => file.endsWith(".wasm") ? wasmPath : file,
        }).then((m) => {
            const mm = m;
            if (!mm.HEAPU8)
                throw new Error("amrwb_module_no_heapu8");
            if (!mm.HEAP16)
                throw new Error("amrwb_module_no_heap16");
            return m;
        });
    }
    return modulePromise;
}
class AmrWbDecoder {
    constructor() {
        this.module = null;
        this.initPromise = null;
        this.initialized = false;
        this.initFn = null;
        this.decodeFn = null;
        this.freeFn = null;
    }
    async init() {
        if (this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.doInit();
        return this.initPromise;
    }
    async doInit() {
        const module = await loadModule();
        this.module = module;
        this.initFn = module.cwrap("amrwb_init", "number", []);
        this.decodeFn = module.cwrap("amrwb_decode_frame", "number", ["number", "number", "number"]);
        this.freeFn = module.cwrap("amrwb_free", null, []);
        const ok = this.initFn();
        if (!ok)
            throw new Error("amrwb_init_failed");
        this.initialized = true;
    }
    decodeFrame(frame) {
        if (!this.initialized || !this.module || !this.decodeFn) {
            throw new Error("amrwb_decoder_not_ready");
        }
        if (!frame || frame.length === 0) {
            throw new Error("amrwb_empty_frame");
        }
        const m = this.module;
        if (!m.HEAPU8 || !m.HEAP16) {
            throw new Error("amrwb_heap_not_ready");
        }
        const inPtr = m._malloc(frame.length);
        const outPtr = m._malloc(FRAME_BYTES);
        if (!inPtr || !outPtr) {
            if (inPtr)
                m._free(inPtr);
            if (outPtr)
                m._free(outPtr);
            throw new Error("amrwb_malloc_failed");
        }
        try {
            m.HEAPU8.set(frame, inPtr);
            const samplesWritten = this.decodeFn(inPtr, frame.length, outPtr);
            if (samplesWritten !== FRAME_SAMPLES) {
                throw new Error(`amrwb_decode_samples_${samplesWritten}`);
            }
            const outIndex = outPtr >> 1;
            const pcm = new Int16Array(FRAME_SAMPLES);
            pcm.set(m.HEAP16.subarray(outIndex, outIndex + FRAME_SAMPLES));
            return pcm;
        }
        finally {
            m._free(inPtr);
            m._free(outPtr);
        }
    }
    dispose() {
        if (!this.initialized || !this.freeFn)
            return;
        try {
            this.freeFn();
        }
        catch {
            // ignore
        }
        this.initialized = false;
    }
}
exports.AmrWbDecoder = AmrWbDecoder;
//# sourceMappingURL=AmrWbDecoder.js.map