"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTelnyxAcceptCodecs = parseTelnyxAcceptCodecs;
exports.shouldUsePcm16Ingest = shouldUsePcm16Ingest;
exports.decodeTelnyxPayloadToPcm16 = decodeTelnyxPayloadToPcm16;
const log_1 = require("../log");
const AmrWbDecoder_1 = require("./vendor/amrwb/AmrWbDecoder");
const g722_1 = require("./vendor/g722/g722");
const OpusDecoder_1 = __importDefault(require("./vendor/opus/OpusDecoder"));
function parseTelnyxAcceptCodecs(raw) {
    const set = new Set();
    if (!raw) {
        return set;
    }
    for (const part of raw.split(',')) {
        const normalized = part.trim().toUpperCase();
        if (normalized) {
            set.add(normalized === 'AMRWB' || normalized === 'AMR_WB' ? 'AMR-WB' : normalized);
        }
    }
    return set;
}
function shouldUsePcm16Ingest(acceptCodecs, allowAmrWb, allowG722, allowOpus) {
    for (const codec of acceptCodecs) {
        if (codec !== 'PCMU') {
            return true;
        }
    }
    return allowAmrWb || allowG722 || allowOpus;
}
const DEFAULT_OPUS_SAMPLE_RATE = 48000;
function clampInt16(value) {
    if (value > 32767)
        return 32767;
    if (value < -32768)
        return -32768;
    return value | 0;
}
function muLawToPcmSample(uLawByte) {
    const u = (~uLawByte) & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const bias = 0x84;
    let sample = ((mantissa << 3) + bias) << exponent;
    sample -= bias;
    if (sign)
        sample = -sample;
    return clampInt16(sample);
}
function aLawToPcmSample(aLawByte) {
    let a = aLawByte ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    switch (seg) {
        case 0:
            t += 8;
            break;
        case 1:
            t += 0x108;
            break;
        default:
            t += 0x108;
            t <<= seg - 1;
            break;
    }
    return (a & 0x80) ? clampInt16(t) : clampInt16(-t);
}
function decodePcmu(payload) {
    const out = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
        out[i] = muLawToPcmSample(payload[i]);
    }
    return out;
}
function decodePcma(payload) {
    const out = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
        out[i] = aLawToPcmSample(payload[i]);
    }
    return out;
}
function downmixInterleaved(pcm, channels) {
    if (channels <= 1) {
        return pcm;
    }
    const frames = Math.floor(pcm.length / channels);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        const base = i * channels;
        for (let c = 0; c < channels; c += 1) {
            sum += pcm[base + c] ?? 0;
        }
        out[i] = clampInt16(Math.round(sum / channels));
    }
    return out;
}
function downmixFloat32(channels) {
    if (channels.length === 0) {
        return new Float32Array();
    }
    if (channels.length === 1) {
        return channels[0];
    }
    const len = channels[0].length;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
        let sum = 0;
        for (const channel of channels) {
            sum += channel[i] ?? 0;
        }
        out[i] = sum / channels.length;
    }
    return out;
}
function floatToPcm16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
        out[i] = clampInt16(Math.round(s * 32767));
    }
    return out;
}
function isFloat32ArrayArray(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }
    return value.every((entry) => entry instanceof Float32Array);
}
function resamplePcm16(input, inputRate, outputRate) {
    if (inputRate <= 0 || outputRate <= 0 || input.length === 0) {
        return input;
    }
    if (inputRate === outputRate) {
        return input;
    }
    const outputLength = Math.max(1, Math.round(input.length * (outputRate / inputRate)));
    const output = new Int16Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i += 1) {
        const position = i * ratio;
        const index = Math.floor(position);
        const nextIndex = Math.min(index + 1, input.length - 1);
        const frac = position - index;
        const sample0 = input[index] ?? 0;
        const sample1 = input[nextIndex] ?? sample0;
        output[i] = clampInt16(Math.round(sample0 + (sample1 - sample0) * frac));
    }
    return output;
}
function looksLikeOgg(payload) {
    if (payload.length < 4) {
        return false;
    }
    return payload.toString('ascii', 0, 4) === 'OggS';
}
async function decodeTelnyxPayloadToPcm16(opts) {
    const encoding = opts.encoding.trim().toUpperCase();
    const channels = opts.channels ?? 1;
    const targetRate = opts.targetSampleRateHz;
    if (encoding === 'PCMU') {
        const pcm = decodePcmu(opts.payload);
        const mono = downmixInterleaved(pcm, channels);
        const resampled = resamplePcm16(mono, 8000, targetRate);
        return { pcm16: resampled, sampleRateHz: targetRate };
    }
    if (encoding === 'PCMA') {
        const pcm = decodePcma(opts.payload);
        const mono = downmixInterleaved(pcm, channels);
        const resampled = resamplePcm16(mono, 8000, targetRate);
        return { pcm16: resampled, sampleRateHz: targetRate };
    }
    if (encoding === 'AMR-WB') {
        if (!opts.allowAmrWb) {
            return null;
        }
        const state = opts.state ?? {};
        if (!state.amrwb && !state.amrwbFailed) {
            state.amrwb = new AmrWbDecoder_1.AmrWbDecoder();
            state.amrwbReady = state.amrwb.init();
        }
        if (!state.amrwb || state.amrwbFailed) {
            return null;
        }
        if (state.amrwbReady) {
            try {
                await state.amrwbReady;
            }
            catch (error) {
                state.amrwbFailed = true;
                state.amrwbLastError = error instanceof Error ? error.message : 'amrwb_init_failed';
                return null;
            }
        }
        try {
            const decoded = state.amrwb.decodeFrame(new Uint8Array(opts.payload));
            const resampled = resamplePcm16(decoded, 16000, targetRate);
            return { pcm16: resampled, sampleRateHz: targetRate };
        }
        catch (error) {
            state.amrwbLastError = error instanceof Error ? error.message : 'amrwb_decode_failed';
            return null;
        }
    }
    if (encoding === 'G722') {
        if (!opts.allowG722) {
            return null;
        }
        const state = opts.state ?? {};
        if (!state.g722) {
            state.g722 = new g722_1.G722Decoder(64000, 0);
        }
        const decoded = state.g722.decode(opts.payload);
        const mono = downmixInterleaved(decoded, channels);
        const resampled = resamplePcm16(mono, 16000, targetRate);
        return { pcm16: resampled, sampleRateHz: targetRate };
    }
    if (encoding === 'OPUS') {
        if (!opts.allowOpus) {
            return null;
        }
        if (looksLikeOgg(opts.payload)) {
            log_1.log.warn({
                event: 'opus_container_detected',
                encoding,
                length: opts.payload.length,
                ...(opts.logContext ?? {}),
            }, 'Opus payload appears to be Ogg; expected raw Opus packets');
            return null;
        }
        const state = opts.state ?? {};
        if (!state.opus && !state.opusFailed) {
            try {
                state.opus = new OpusDecoder_1.default();
                state.opusReady = state.opus.ready;
            }
            catch (error) {
                state.opusFailed = true;
                log_1.log.warn({ err: error, event: 'opus_decoder_init_failed', ...(opts.logContext ?? {}) }, 'Opus decoder init failed');
                return null;
            }
        }
        if (!state.opus || state.opusFailed) {
            return null;
        }
        if (state.opusReady) {
            try {
                await state.opusReady;
            }
            catch (error) {
                state.opusFailed = true;
                log_1.log.warn({ err: error, event: 'opus_decoder_ready_failed', ...(opts.logContext ?? {}) }, 'Opus decoder ready failed');
                return null;
            }
        }
        const result = state.opus.decodeFrame(new Uint8Array(opts.payload));
        if (!result || !isFloat32ArrayArray(result.channelData)) {
            return null;
        }
        const monoFloat = downmixFloat32(result.channelData);
        const pcm = floatToPcm16(monoFloat);
        const inputRate = typeof result.sampleRate === 'number' ? result.sampleRate : DEFAULT_OPUS_SAMPLE_RATE;
        const resampled = resamplePcm16(pcm, inputRate, targetRate);
        return { pcm16: resampled, sampleRateHz: targetRate };
    }
    return null;
}
//# sourceMappingURL=codecDecode.js.map