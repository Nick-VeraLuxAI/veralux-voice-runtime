"use strict";
// src/audio/aecProcessor.ts
//
// Tier 4: AEC Processor
// Buffers inbound PCM to 20ms frames, pulls far-end reference, runs Speex AEC,
// and emits cleaned frames. When AEC is unavailable or no far-end, passthrough.
Object.defineProperty(exports, "__esModule", { value: true });
exports.speexAecAvailable = void 0;
exports.releaseAecProcessor = releaseAecProcessor;
exports.resetAecProcessor = resetAecProcessor;
exports.processAec = processAec;
exports.flushAecProcessor = flushAecProcessor;
const farEndReference_1 = require("./farEndReference");
const speexAec_1 = require("./speexAec");
Object.defineProperty(exports, "speexAecAvailable", { enumerable: true, get: function () { return speexAec_1.speexAecAvailable; } });
const BYTES_PER_FRAME = speexAec_1.AEC_FRAME_SAMPLES * 2; // 640
const stateByCall = new Map();
function getOrCreateState(callControlId) {
    let st = stateByCall.get(callControlId);
    if (!st) {
        st = {
            aecState: (0, speexAec_1.createSpeexAecState)(),
            buffer: Buffer.alloc(0),
            bufferSamples: 0,
        };
        stateByCall.set(callControlId, st);
    }
    return st;
}
function releaseAecProcessor(callControlId) {
    const st = stateByCall.get(callControlId);
    if (st) {
        if (st.aecState)
            (0, speexAec_1.destroySpeexAecState)(st.aecState);
        stateByCall.delete(callControlId);
    }
}
function resetAecProcessor(callControlId) {
    const st = stateByCall.get(callControlId);
    if (st?.aecState) {
        (0, speexAec_1.resetSpeexAecState)(st.aecState);
    }
    // Clear buffer on playback transition
    if (st) {
        st.buffer = Buffer.alloc(0);
        st.bufferSamples = 0;
    }
}
/**
 * Process inbound PCM through AEC (when available) and emit cleaned frames.
 * Callback is invoked for each 20ms frame.
 */
function processAec(callControlId, pcm16, sampleRateHz, onFrame, logContext) {
    if (sampleRateHz !== 16000) {
        onFrame(pcm16, sampleRateHz);
        return;
    }
    const st = getOrCreateState(callControlId);
    // Append to buffer
    const newBytes = pcm16.length * 2;
    st.buffer = Buffer.concat([st.buffer, Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)]);
    st.bufferSamples += pcm16.length;
    // Process complete 20ms frames
    while (st.bufferSamples >= speexAec_1.AEC_FRAME_SAMPLES) {
        const nearFrame = st.buffer.subarray(0, BYTES_PER_FRAME);
        const farFrame = (0, farEndReference_1.pullFarEndFrame)(callControlId);
        let output;
        if (speexAec_1.speexAecAvailable && st.aecState && farFrame && farFrame.length >= BYTES_PER_FRAME) {
            output = Buffer.alloc(BYTES_PER_FRAME);
            (0, speexAec_1.speexEchoCancel)(st.aecState, nearFrame, farFrame, output);
        }
        else {
            output = nearFrame;
        }
        const outSamples = new Int16Array(speexAec_1.AEC_FRAME_SAMPLES);
        outSamples.set(new Int16Array(output.buffer, output.byteOffset, speexAec_1.AEC_FRAME_SAMPLES));
        onFrame(outSamples, sampleRateHz);
        st.buffer = st.buffer.subarray(BYTES_PER_FRAME);
        st.bufferSamples -= speexAec_1.AEC_FRAME_SAMPLES;
    }
}
/** Flush any remaining buffered samples (passthrough). */
function flushAecProcessor(callControlId, onFrame, sampleRateHz) {
    const st = stateByCall.get(callControlId);
    if (!st || st.bufferSamples === 0)
        return;
    const samples = Math.floor(st.buffer.length / 2);
    if (samples > 0) {
        const pcm16 = new Int16Array(st.buffer.buffer, st.buffer.byteOffset, samples);
        onFrame(pcm16, sampleRateHz);
    }
    st.buffer = Buffer.alloc(0);
    st.bufferSamples = 0;
}
//# sourceMappingURL=aecProcessor.js.map