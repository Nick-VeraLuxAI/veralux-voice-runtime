"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processTelephonyTTS = processTelephonyTTS;
exports.runPlaybackPipeline = runPlaybackPipeline;
const log_1 = require("../log");
const audioProbe_1 = require("../diagnostics/audioProbe");
const HPF_CUTOFF_HZ = 100;
const DEESSER_LOW_HZ = 5500;
const DEESSER_HIGH_HZ = 8000;
const DEESSER_ATTACK_MS = 5;
const DEESSER_RELEASE_MS = 60;
const DEESSER_RATIO = 4;
const DEESSER_THRESHOLD = 0.12;
const DEESSER_MIN_GAIN = 0.7;
const LOWPASS_16K_CUTOFF_HZ = 7200;
const LOWPASS_8K_CUTOFF_HZ = 3400;
const LIMITER_THRESHOLD = 0.9;
const RMS_TARGET = 0.16;
const RMS_MAX_GAIN = 1.4;
const PEAK_SAFETY = 0.98;
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown_error';
}
function isRiffWav(buffer) {
    return (buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WAVE');
}
function parseWavHeader(buffer) {
    if (!isRiffWav(buffer)) {
        throw new Error('invalid_riff_header');
    }
    let offset = 12;
    let audioFormat = null;
    let channels = null;
    let sampleRateHz = null;
    let bitsPerSample = null;
    let dataOffset = 0;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        if (chunkId === 'fmt ') {
            if (chunkStart + 16 > buffer.length) {
                throw new Error('fmt_chunk_truncated');
            }
            audioFormat = buffer.readUInt16LE(chunkStart);
            channels = buffer.readUInt16LE(chunkStart + 2);
            sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
            bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
        }
        else if (chunkId === 'data') {
            dataOffset = chunkStart;
            dataBytes = chunkSize;
        }
        const paddedSize = chunkSize + (chunkSize % 2);
        const nextOffset = chunkStart + paddedSize;
        if (nextOffset <= offset) {
            break;
        }
        offset = nextOffset;
    }
    if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
        throw new Error('missing_fmt_chunk');
    }
    if (dataOffset === 0 || dataBytes === 0) {
        throw new Error('missing_data_chunk');
    }
    return {
        audioFormat,
        channels,
        sampleRateHz,
        bitsPerSample,
        dataOffset,
        dataBytes,
    };
}
function clampInt16(n) {
    if (n > 32767)
        return 32767;
    if (n < -32768)
        return -32768;
    return n | 0;
}
function computeRms(samples) {
    if (samples.length === 0)
        return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i] ?? 0;
        sum += s * s;
    }
    return Math.sqrt(sum / samples.length);
}
function computePeak(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const abs = Math.abs(samples[i] ?? 0);
        if (abs > peak)
            peak = abs;
    }
    return peak;
}
function highPassFilter(samples, sampleRateHz) {
    const sr = sampleRateHz > 0 ? sampleRateHz : 8000;
    const dt = 1 / sr;
    const rc = 1 / (2 * Math.PI * HPF_CUTOFF_HZ);
    const alpha = rc / (rc + dt);
    const output = new Float32Array(samples.length);
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const input = samples[i] ?? 0;
        const out = alpha * (prevOut + input - prevIn);
        output[i] = out;
        prevIn = input;
        prevOut = out;
    }
    return output;
}
function createLowPassBiquad(sampleRateHz, cutoffHz, q) {
    const omega = (2 * Math.PI * cutoffHz) / sampleRateHz;
    const cos = Math.cos(omega);
    const sin = Math.sin(omega);
    const alpha = sin / (2 * q);
    const b0 = (1 - cos) / 2;
    const b1 = 1 - cos;
    const b2 = (1 - cos) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    return {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    };
}
function createBandPassBiquad(sampleRateHz, centerHz, q) {
    const omega = (2 * Math.PI * centerHz) / sampleRateHz;
    const cos = Math.cos(omega);
    const sin = Math.sin(omega);
    const alpha = sin / (2 * q);
    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    return {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    };
}
function applyBiquad(samples, coeffs) {
    const output = new Float32Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const x0 = samples[i] ?? 0;
        const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
        output[i] = y0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
    }
    return output;
}
function applyDeEsser(samples, sampleRateHz) {
    const centerHz = (DEESSER_LOW_HZ + DEESSER_HIGH_HZ) / 2;
    const q = centerHz / (DEESSER_HIGH_HZ - DEESSER_LOW_HZ);
    const coeffs = createBandPassBiquad(sampleRateHz, centerHz, q);
    const band = applyBiquad(samples, coeffs);
    const output = new Float32Array(samples.length);
    const attackCoef = Math.exp(-1 / (sampleRateHz * (DEESSER_ATTACK_MS / 1000)));
    const releaseCoef = Math.exp(-1 / (sampleRateHz * (DEESSER_RELEASE_MS / 1000)));
    let env = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const bandSample = band[i] ?? 0;
        const abs = Math.abs(bandSample);
        if (abs > env) {
            env = attackCoef * env + (1 - attackCoef) * abs;
        }
        else {
            env = releaseCoef * env + (1 - releaseCoef) * abs;
        }
        let gain = 1;
        if (env > DEESSER_THRESHOLD) {
            const outEnv = DEESSER_THRESHOLD + (env - DEESSER_THRESHOLD) / DEESSER_RATIO;
            gain = outEnv / env;
            if (gain < DEESSER_MIN_GAIN)
                gain = DEESSER_MIN_GAIN;
        }
        output[i] = (samples[i] ?? 0) + bandSample * (gain - 1);
    }
    return output;
}
function applySoftLimiter(samples) {
    const knee = 1 - LIMITER_THRESHOLD;
    for (let i = 0; i < samples.length; i += 1) {
        const x = samples[i] ?? 0;
        const abs = Math.abs(x);
        if (abs <= LIMITER_THRESHOLD) {
            continue;
        }
        const excess = abs - LIMITER_THRESHOLD;
        const shaped = LIMITER_THRESHOLD + knee * Math.tanh(excess / knee);
        samples[i] = Math.sign(x) * shaped;
    }
}
function applyRmsNormalize(samples) {
    const rms = computeRms(samples);
    if (rms <= 0) {
        return false;
    }
    let gain = RMS_TARGET / rms;
    if (gain > RMS_MAX_GAIN) {
        gain = RMS_MAX_GAIN;
    }
    if (gain === 1) {
        return false;
    }
    const peak = computePeak(samples);
    if (peak > 0 && peak * gain > PEAK_SAFETY) {
        gain = PEAK_SAFETY / peak;
    }
    if (gain === 1) {
        return false;
    }
    for (let i = 0; i < samples.length; i += 1) {
        samples[i] = (samples[i] ?? 0) * gain;
    }
    return true;
}
function resampleLinear(samples, inputRate, outputRate) {
    if (samples.length === 0)
        return samples;
    if (inputRate <= 0 || outputRate <= 0)
        return samples;
    if (inputRate === outputRate)
        return samples;
    const outputLength = Math.max(1, Math.round(samples.length * (outputRate / inputRate)));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i += 1) {
        const position = i * ratio;
        const index = Math.floor(position);
        const nextIndex = Math.min(index + 1, samples.length - 1);
        const frac = position - index;
        const s0 = samples[index] ?? 0;
        const s1 = samples[nextIndex] ?? s0;
        output[i] = s0 + (s1 - s0) * frac;
    }
    return output;
}
function wavHeader(pcmDataBytes, sampleRate, channels) {
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcmDataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcmDataBytes, 40);
    return header;
}
function encodeWavFromPcm16(samples, sampleRateHz) {
    const pcmBuffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const header = wavHeader(pcmBuffer.length, sampleRateHz, 1);
    return Buffer.concat([header, pcmBuffer]);
}
function toFloat32(pcm) {
    if (pcm instanceof Float32Array) {
        return pcm;
    }
    const output = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
        output[i] = (pcm[i] ?? 0) / 32768;
    }
    return output;
}
function toPcm16(samples) {
    const output = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
        output[i] = clampInt16(Math.round(clamped * 32767));
    }
    return output;
}
function resolveLowpassCutoff(inputSampleRate, outputSampleRate) {
    const desired = outputSampleRate <= 8000 ? LOWPASS_8K_CUTOFF_HZ : LOWPASS_16K_CUTOFF_HZ;
    const maxCutoff = Math.max(50, inputSampleRate * 0.45);
    return Math.min(desired, maxCutoff);
}
function processTelephonyTTSInternal(pcm, inputSampleRate, outputSampleRate, options) {
    let working = toFloat32(pcm);
    const appliedHighpass = options.enableHighpass;
    const appliedDeEsser = inputSampleRate >= DEESSER_HIGH_HZ * 2;
    const lowpassCutoffHz = resolveLowpassCutoff(inputSampleRate, outputSampleRate);
    const appliedLowpass = true;
    if (appliedHighpass) {
        working = highPassFilter(working, inputSampleRate);
    }
    if (appliedDeEsser) {
        working = applyDeEsser(working, inputSampleRate);
    }
    const lowpassCoeffs = createLowPassBiquad(inputSampleRate, lowpassCutoffHz, 0.707);
    working = applyBiquad(working, lowpassCoeffs);
    const appliedResample = inputSampleRate !== outputSampleRate;
    if (appliedResample) {
        working = resampleLinear(working, inputSampleRate, outputSampleRate);
    }
    applySoftLimiter(working);
    const appliedLimiter = true;
    const appliedRmsNormalize = options.enableRmsNormalize ? applyRmsNormalize(working) : false;
    return {
        pcm16: toPcm16(working),
        appliedHighpass,
        appliedDeEsser,
        appliedLowpass,
        appliedResample,
        appliedLimiter,
        appliedRmsNormalize,
        lowpassCutoffHz,
        outputSampleRateHz: outputSampleRate,
    };
}
function processTelephonyTTS(pcm, inputSampleRate, outputSampleRate) {
    return processTelephonyTTSInternal(pcm, inputSampleRate, outputSampleRate, {
        enableHighpass: true,
        enableRmsNormalize: true,
    }).pcm16;
}
function runPlaybackPipeline(input, options) {
    try {
        const header = parseWavHeader(input);
        if (header.audioFormat !== 1) {
            throw new Error('unsupported_audio_format');
        }
        if (header.channels !== 1) {
            throw new Error('unsupported_channel_count');
        }
        if (header.bitsPerSample !== 16) {
            throw new Error('unsupported_bits_per_sample');
        }
        const availableBytes = Math.min(header.dataBytes, Math.max(0, input.length - header.dataOffset));
        if (availableBytes <= 0) {
            throw new Error('invalid_data_bytes');
        }
        const sampleCount = Math.floor(availableBytes / 2);
        if (sampleCount <= 0) {
            throw new Error('invalid_sample_count');
        }
        let meta = (0, audioProbe_1.getAudioMeta)(input) ?? {
            format: 'wav',
            sampleRateHz: header.sampleRateHz,
            channels: header.channels,
            bitDepth: header.bitsPerSample,
            logContext: options.logContext,
            lineage: [],
        };
        meta = {
            ...meta,
            logContext: options.logContext ?? meta.logContext,
            sampleRateHz: header.sampleRateHz,
            channels: header.channels,
            bitDepth: header.bitsPerSample,
        };
        meta = (0, audioProbe_1.appendLineage)(meta, 'decode:wav->pcm16le');
        const pcm16 = new Int16Array(sampleCount);
        for (let i = 0; i < sampleCount; i += 1) {
            const offset = header.dataOffset + i * 2;
            if (offset + 2 > input.length)
                break;
            pcm16[i] = input.readInt16LE(offset);
        }
        const enableHighpass = options.enableHighpass ?? true;
        const enableRmsNormalize = options.enableRmsNormalize ?? true;
        const result = processTelephonyTTSInternal(pcm16, header.sampleRateHz, options.targetSampleRateHz, {
            enableHighpass,
            enableRmsNormalize,
        });
        if (result.appliedHighpass) {
            meta = (0, audioProbe_1.appendLineage)(meta, 'filter:highpass_100hz');
        }
        if (result.appliedDeEsser) {
            meta = (0, audioProbe_1.appendLineage)(meta, `deesser:${DEESSER_LOW_HZ}-${DEESSER_HIGH_HZ}hz`);
        }
        if (result.appliedLowpass) {
            meta = (0, audioProbe_1.appendLineage)(meta, `filter:lowpass_${Math.round(result.lowpassCutoffHz)}hz`);
        }
        if (result.appliedResample) {
            meta = (0, audioProbe_1.appendLineage)(meta, `resample:${header.sampleRateHz}->${result.outputSampleRateHz}`);
        }
        if (result.appliedLimiter) {
            meta = (0, audioProbe_1.appendLineage)(meta, 'limiter:soft');
        }
        if (result.appliedRmsNormalize) {
            meta = (0, audioProbe_1.appendLineage)(meta, 'normalize:rms');
        }
        meta = (0, audioProbe_1.appendLineage)(meta, 'wrap:wav');
        meta = {
            ...meta,
            format: 'wav',
            sampleRateHz: result.outputSampleRateHz,
            channels: 1,
            bitDepth: 16,
        };
        const output = encodeWavFromPcm16(result.pcm16, result.outputSampleRateHz);
        (0, audioProbe_1.attachAudioMeta)(output, meta);
        log_1.log.info({
            event: 'tts_telephony_mastering_applied',
            input_sr: header.sampleRateHz,
            output_sr: result.outputSampleRateHz,
            ...(options.logContext ?? {}),
        }, 'tts telephony mastering applied');
        return {
            audio: output,
            applied: true,
        };
    }
    catch (error) {
        log_1.log.warn({
            event: 'playback_pipeline_fallback',
            reason: getErrorMessage(error),
            ...(options.logContext ?? {}),
        }, 'playback pipeline fallback');
        return { audio: input, applied: false };
    }
}
//# sourceMappingURL=playbackPipeline.js.map