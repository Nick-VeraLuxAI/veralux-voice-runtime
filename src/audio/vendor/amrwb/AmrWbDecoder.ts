import path from "path";
import createAmrWbModule, { type AmrWbModule } from "./amrwb.js";

const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;

// IMPORTANT: tsx + CJS runtime → __dirname is valid
const wasmDir = __dirname;

let modulePromise: Promise<AmrWbModule> | null = null;

async function loadModule(): Promise<AmrWbModule> {
  if (!modulePromise) {
    const wasmPath = path.join(wasmDir, "amrwb.wasm");

    modulePromise = createAmrWbModule({
      locateFile: (file: string) =>
        file.endsWith(".wasm") ? wasmPath : file,
    }).then((m) => {
      const mm = m as any;
      if (!mm.HEAPU8) throw new Error("amrwb_module_no_heapu8");
      if (!mm.HEAP16) throw new Error("amrwb_module_no_heap16");
      return m;
    });
  }
  return modulePromise;
}

export class AmrWbDecoder {
  private module: AmrWbModule | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  private initFn: (() => number) | null = null;
  private decodeFn:
    | ((inPtr: number, inLen: number, outPtr: number) => number)
    | null = null;
  private freeFn: (() => void) | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const module = await loadModule();
    this.module = module;

    this.initFn = module.cwrap("amrwb_init", "number", []);
    this.decodeFn = module.cwrap(
      "amrwb_decode_frame",
      "number",
      ["number", "number", "number"]
    );
    this.freeFn = module.cwrap("amrwb_free", null, []);

    const ok = this.initFn();
    if (!ok) throw new Error("amrwb_init_failed");

    this.initialized = true;
  }

  decodeFrame(frame: Uint8Array): Int16Array {
    if (!this.initialized || !this.module || !this.decodeFn) {
      throw new Error("amrwb_decoder_not_ready");
    }
    if (!frame || frame.length === 0) {
      throw new Error("amrwb_empty_frame");
    }

    const m: any = this.module;
    if (!m.HEAPU8 || !m.HEAP16) {
      throw new Error("amrwb_heap_not_ready");
    }

    const inPtr = m._malloc(frame.length);
    const outPtr = m._malloc(FRAME_BYTES);

    if (!inPtr || !outPtr) {
      if (inPtr) m._free(inPtr);
      if (outPtr) m._free(outPtr);
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
    } finally {
      m._free(inPtr);
      m._free(outPtr);
    }
  }

  dispose(): void {
    if (!this.initialized || !this.freeFn) return;
    try {
      this.freeFn();
    } catch {
      // ignore
    }
    this.initialized = false;
  }
}