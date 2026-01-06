"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkedSTT = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
const metrics_1 = require("../metrics");
const audioProbe_1 = require("../diagnostics/audioProbe");
const DEFAULT_PARTIAL_INTERVAL_MS = 250;
const DEFAULT_SILENCE_END_MS = 900;
const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_MAX_UTTERANCE_MS = 6000;
const DEFAULT_MIN_SECONDS = 0.6;
const DEFAULT_SILENCE_MIN_SECONDS = 0.45;
const DEFAULT_FINAL_TAIL_CUSHION_MS = 120;
const DEFAULT_FINAL_MIN_SECONDS = 1.0;
// Speech detection defaults (your env.ts may override)
const DEFAULT_SPEECH_RMS_FLOOR = 0.03;
const DEFAULT_SPEECH_PEAK_FLOOR = 0.08;
const DEFAULT_SPEECH_FRAMES_REQUIRED = 8;
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}
function safeNum(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const v = Number(value.trim());
        if (Number.isFinite(v))
            return v;
    }
    return fallback;
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function isNonEmpty(text) {
    return normalizeWhitespace(text).length > 0;
}
function parseBool(value) {
    if (typeof value !== 'string')
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}
function isAbortError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const name = error.name;
    return name === 'AbortError';
}
function computeRmsAndPeak(pcm16le) {
    if (pcm16le.length < 2)
        return { rms: 0, peak: 0 };
    const samples = Math.floor(pcm16le.length / 2);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples; i++) {
        const s = pcm16le.readInt16LE(i * 2) / 32768;
        const a = Math.abs(s);
        if (a > peak)
            peak = a;
        sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / samples);
    return { rms, peak };
}
function clampInt16(n) {
    if (n > 32767)
        return 32767;
    if (n < -32768)
        return -32768;
    return n | 0;
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
function pcmuToPcm16le(pcmu) {
    const output = Buffer.alloc(pcmu.length * 2);
    for (let i = 0; i < pcmu.length; i += 1) {
        const sample = muLawToPcmSample(pcmu[i]);
        output.writeInt16LE(sample, i * 2);
    }
    return output;
}
class ChunkedSTT {
    constructor(opts) {
        // State
        this.firstFrameLogged = false;
        this.inSpeech = false;
        this.speechMs = 0;
        /** updated continuously while speech is happening */
        this.lastSpeechAt = 0;
        this.silenceMsAccum = 0;
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.utteranceFrames = [];
        this.utteranceLineage = [];
        this.speechFrameStreak = 0;
        this.silenceFrameStreak = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.lastNonEmptyPartialAt = 0;
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.inFlight = false;
        this.inFlightToken = 0;
        this.decodedProbeLogged = false;
        this.provider = opts.provider;
        this.whisperUrl = opts.whisperUrl;
        this.language = opts.language;
        this.logContext = opts.logContext;
        this.tenantLabel = opts.logContext?.tenant_id ?? 'unknown';
        this.inputCodec = opts.inputCodec ?? 'pcmu';
        const sampleRate = safeNum(opts.sampleRate, 8000);
        this.sampleRate = sampleRate > 0 ? sampleRate : 8000;
        this.bytesPerSecond = this.sampleRate * 2;
        this.fallbackFrameMs = safeNum(opts.frameMs, env_1.env.STT_CHUNK_MS);
        const minSeconds = safeNum(env_1.env.STT_MIN_SECONDS, DEFAULT_MIN_SECONDS);
        this.minSpeechMs = Math.max(0, minSeconds) * 1000;
        const silenceMinSeconds = safeNum(env_1.env.STT_SILENCE_MIN_SECONDS, DEFAULT_SILENCE_MIN_SECONDS);
        this.silenceMinSeconds =
            silenceMinSeconds > 0 ? silenceMinSeconds : DEFAULT_SILENCE_MIN_SECONDS;
        const finalTailCushionMs = safeNum(env_1.env.FINAL_TAIL_CUSHION_MS, DEFAULT_FINAL_TAIL_CUSHION_MS);
        this.finalTailCushionMs = clamp(finalTailCushionMs, 0, 2000);
        const finalMinSeconds = safeNum(env_1.env.FINAL_MIN_SECONDS, DEFAULT_FINAL_MIN_SECONDS);
        const computedFinalMinBytes = Math.round(this.bytesPerSecond * Math.max(0, finalMinSeconds));
        const finalMinBytes = safeNum(env_1.env.FINAL_MIN_BYTES, computedFinalMinBytes);
        this.finalMinBytes = Math.max(0, Math.round(finalMinBytes));
        this.partialMinBytes = Math.round(this.bytesPerSecond * 0.5);
        this.onTranscript = opts.onTranscript;
        this.onSpeechStart = opts.onSpeechStart;
        this.partialIntervalMs = clamp(safeNum(opts.partialIntervalMs, env_1.env.STT_PARTIAL_INTERVAL_MS ?? DEFAULT_PARTIAL_INTERVAL_MS), 100, 10000);
        this.preRollMaxMs = clamp(safeNum(opts.preRollMs, env_1.env.STT_PRE_ROLL_MS ?? DEFAULT_PRE_ROLL_MS), 0, 2000);
        this.silenceEndMs = clamp(safeNum(opts.silenceEndMs, env_1.env.STT_SILENCE_END_MS ?? DEFAULT_SILENCE_END_MS), 100, 8000);
        this.maxUtteranceMs = clamp(safeNum(opts.maxUtteranceMs, env_1.env.STT_MAX_UTTERANCE_MS ?? DEFAULT_MAX_UTTERANCE_MS), 2000, 60000);
        this.speechRmsFloor = safeNum(opts.speechRmsFloor, env_1.env.STT_SPEECH_RMS_FLOOR ?? DEFAULT_SPEECH_RMS_FLOOR);
        this.speechPeakFloor = safeNum(opts.speechPeakFloor, env_1.env.STT_SPEECH_PEAK_FLOOR ?? DEFAULT_SPEECH_PEAK_FLOOR);
        this.speechFramesRequired = clamp(safeNum(opts.speechFramesRequired, env_1.env.STT_SPEECH_FRAMES_REQUIRED ?? DEFAULT_SPEECH_FRAMES_REQUIRED), 1, 6);
        log_1.log.info({
            event: 'stt_tuning',
            stt_tuning: {
                rms_floor: this.speechRmsFloor,
                peak_floor: this.speechPeakFloor,
                frames_required: this.speechFramesRequired,
                chunk_ms: this.fallbackFrameMs,
                partial_interval_ms: this.partialIntervalMs,
                pre_roll_ms: this.preRollMaxMs,
                silence_end_ms: this.silenceEndMs,
                max_utt_ms: this.maxUtteranceMs,
                final_tail_cushion_ms: this.finalTailCushionMs,
                final_min_bytes: this.finalMinBytes,
            },
            ...(this.logContext ?? {}),
        }, 'stt tuning');
        this.timer = setInterval(() => {
            try {
                this.flushIfReady('interval');
            }
            catch (err) {
                log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt interval flush failed');
            }
        }, this.partialIntervalMs);
    }
    buildAudioMeta(overrides = {}) {
        const callIdRaw = this.logContext?.call_control_id;
        const callId = typeof callIdRaw === 'string' ? callIdRaw : undefined;
        const tenantId = typeof this.logContext?.tenant_id === 'string' ? this.logContext.tenant_id : undefined;
        return {
            callId,
            tenantId,
            logContext: this.logContext,
            ...overrides,
        };
    }
    mergeLineageFromBuffer(buffer) {
        const meta = (0, audioProbe_1.getAudioMeta)(buffer);
        if (!meta?.lineage)
            return;
        for (const entry of meta.lineage) {
            if (!this.utteranceLineage.includes(entry)) {
                this.utteranceLineage.push(entry);
            }
        }
    }
    mergeLineageFromFrames(frames) {
        for (const frame of frames) {
            this.mergeLineageFromBuffer(frame.buffer);
        }
    }
    ingest(pcm) {
        if (!pcm || pcm.length === 0)
            return;
        const bytesPerSample = this.inputCodec === 'pcmu' ? 1 : 2;
        const samples = pcm.length / bytesPerSample;
        const computedFrameMs = (samples / this.sampleRate) * 1000;
        const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0
            ? computedFrameMs
            : this.fallbackFrameMs;
        // First-frame log (helps confirm audio is arriving)
        if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            log_1.log.info({
                event: 'stt_first_audio_frame',
                frame_bytes: pcm.length,
                frame_ms: Math.round(frameMs),
                silence_end_ms: this.silenceEndMs,
                partial_interval_ms: this.partialIntervalMs,
                ...(this.logContext ?? {}),
            }, 'stt first audio frame');
        }
        let rawMeta = (0, audioProbe_1.getAudioMeta)(pcm);
        if (!rawMeta) {
            rawMeta = this.buildAudioMeta({
                format: this.inputCodec === 'pcmu' ? 'pcmu' : 'pcm16le',
                sampleRateHz: this.sampleRate,
                channels: 1,
                bitDepth: this.inputCodec === 'pcmu' ? 8 : 16,
                lineage: ['rx.telnyx.raw'],
            });
            (0, audioProbe_1.attachAudioMeta)(pcm, rawMeta);
        }
        const frame = this.inputCodec === 'pcmu' ? pcmuToPcm16le(pcm) : pcm;
        const decodedMeta = (0, audioProbe_1.appendLineage)(rawMeta, this.inputCodec === 'pcmu' ? 'decode:pcmu->pcm16le' : 'passthrough:pcm16le');
        (0, audioProbe_1.attachAudioMeta)(frame, decodedMeta);
        if (!this.decodedProbeLogged) {
            this.decodedProbeLogged = true;
            (0, audioProbe_1.probePcm)('rx.decoded.pcm', frame, {
                ...decodedMeta,
                format: 'pcm16le',
                sampleRateHz: this.sampleRate,
                channels: 1,
                bitDepth: 16,
            });
        }
        const stats = computeRmsAndPeak(frame);
        const isSpeech = stats.rms >= this.speechRmsFloor;
        if (this.inFlight && this.inFlightKind === 'final' && isSpeech) {
            this.abortInFlight('barge_in');
            this.resetUtteranceState();
        }
        if (!this.inSpeech) {
            // Maintain pre-roll buffer while idle
            this.addPreRollFrame(frame, frameMs);
            if (isSpeech) {
                this.silenceFrameStreak = 0;
                this.silenceToFinalizeTimer = undefined;
                this.speechFrameStreak += 1;
            }
            else {
                this.speechFrameStreak = 0;
            }
            if (isSpeech && this.speechFrameStreak >= this.speechFramesRequired) {
                this.startSpeech(stats, frameMs);
                if (this.onSpeechStart)
                    this.onSpeechStart();
            }
            return;
        }
        // In speech: append to utterance
        this.appendUtterance(frame, frameMs);
        if (isSpeech) {
            // ✅ IMPORTANT: update lastSpeechAt continuously (not just at startSpeech)
            this.lastSpeechAt = Date.now();
            this.speechMs += frameMs;
            this.silenceMsAccum = 0;
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
        else {
            this.silenceMsAccum += frameMs;
            if (this.silenceFrameStreak === 0) {
                this.silenceToFinalizeTimer = (0, metrics_1.startStageTimer)('stt_silence_to_finalize_ms', this.tenantLabel);
            }
            this.silenceFrameStreak += 1;
            const silenceFramesNeeded = Math.max(1, Math.ceil((this.silenceMinSeconds * 1000) / frameMs));
            if (this.silenceFrameStreak >= silenceFramesNeeded) {
                if (this.silenceToFinalizeTimer) {
                    this.silenceToFinalizeTimer();
                    this.silenceToFinalizeTimer = undefined;
                }
                this.finalizeUtterance('silence');
                return;
            }
        }
        if (this.utteranceMs >= this.maxUtteranceMs) {
            this.finalizeUtterance('max');
            return;
        }
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        if (this.inSpeech && this.utteranceBytes > 0) {
            this.flushIfReady('stop');
        }
    }
    flushIfReady(reason) {
        if (reason === 'interval') {
            this.maybeSendPartial();
            return;
        }
        if (reason === 'stop') {
            this.finalizeUtterance('stop');
            return;
        }
        this.finalizeUtterance('silence');
    }
    addPreRollFrame(pcm, frameMs) {
        if (this.preRollMaxMs <= 0)
            return;
        this.preRollFrames.push({ buffer: pcm, ms: frameMs });
        this.preRollMs += frameMs;
        this.mergeLineageFromBuffer(pcm);
        while (this.preRollMs > this.preRollMaxMs && this.preRollFrames.length > 0) {
            const dropped = this.preRollFrames.shift();
            if (!dropped)
                break;
            this.preRollMs -= dropped.ms;
        }
    }
    startSpeech(stats, frameMs) {
        this.inSpeech = true;
        this.lastSpeechAt = Date.now();
        this.silenceMsAccum = 0;
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.speechMs = this.speechFrameStreak * frameMs;
        this.utteranceFrames = [...this.preRollFrames];
        this.utteranceMs = this.preRollMs;
        this.utteranceBytes = this.utteranceFrames.reduce((sum, frame) => sum + frame.buffer.length, 0);
        this.utteranceLineage = [];
        this.mergeLineageFromFrames(this.utteranceFrames);
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.lastNonEmptyPartialAt = 0;
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        (0, audioProbe_1.markAudioSpan)('rx', this.buildAudioMeta({
            lineage: [...this.utteranceLineage],
        }));
        log_1.log.info({
            event: 'stt_speech_start',
            speech_rms: Number(stats.rms.toFixed(4)),
            speech_peak: Number(stats.peak.toFixed(4)),
            ...(this.logContext ?? {}),
        }, 'stt speech start');
    }
    appendUtterance(pcm, frameMs) {
        this.utteranceFrames.push({ buffer: pcm, ms: frameMs });
        this.utteranceMs += frameMs;
        this.utteranceBytes += pcm.length;
        this.mergeLineageFromBuffer(pcm);
    }
    trimTrailingSilence(frames) {
        if (frames.length === 0)
            return frames;
        let lastSpeechIndex = -1;
        for (let i = frames.length - 1; i >= 0; i -= 1) {
            const stats = computeRmsAndPeak(frames[i].buffer);
            if (stats.rms >= this.speechRmsFloor) {
                lastSpeechIndex = i;
                break;
            }
        }
        if (lastSpeechIndex === -1)
            return frames;
        let endIndex = lastSpeechIndex;
        let tailMs = 0;
        for (let i = lastSpeechIndex + 1; i < frames.length; i += 1) {
            tailMs += frames[i].ms;
            endIndex = i;
            if (tailMs >= this.finalTailCushionMs) {
                break;
            }
        }
        if (endIndex >= frames.length - 1)
            return frames;
        return frames.slice(0, endIndex + 1);
    }
    maybeSendPartial() {
        if (!this.inSpeech)
            return;
        if (this.inFlight)
            return;
        if (this.utteranceMs < this.minSpeechMs)
            return;
        const now = Date.now();
        if (this.lastPartialAt > 0 && now - this.lastPartialAt < this.partialIntervalMs)
            return;
        const payload = this.concatFrames(this.utteranceFrames);
        if (payload.length < this.partialMinBytes)
            return;
        this.lastPartialAt = now;
        this.enqueueTranscription(payload, {
            reason: 'partial',
            isFinal: false,
            lineage: [...this.utteranceLineage],
        });
    }
    finalizeUtterance(reason) {
        if (!this.inSpeech || this.utteranceBytes === 0) {
            return;
        }
        // ✅ Record pre_stt_gate ONLY ONCE per utterance:
        // - only when silence triggers finalization
        // - only the first time we request a final flush (finalFlushAt == 0)
        if (this.finalFlushAt === 0) {
            this.finalFlushAt = Date.now();
            if (reason === 'silence' && this.lastSpeechAt > 0) {
                const gateMs = Date.now() - this.lastSpeechAt;
                (0, metrics_1.observeStageDuration)('pre_stt_gate', this.tenantLabel, gateMs);
            }
        }
        if (this.inFlight) {
            if (this.inFlightKind === 'final') {
                return;
            }
            this.abortInFlight('finalize');
        }
        const trimmedFrames = this.trimTrailingSilence(this.utteranceFrames);
        const trimmedMs = trimmedFrames.reduce((sum, frame) => sum + frame.ms, 0);
        const payload = this.concatFrames(trimmedFrames);
        (0, metrics_1.observeStageDuration)('stt_finalize_audio_ms', this.tenantLabel, trimmedMs);
        log_1.log.info({
            event: 'stt_final_flush_forced',
            final_reason: reason,
            utterance_bytes: payload.length,
            utterance_ms: this.utteranceMs,
            duration_ms_estimate: Math.round(trimmedMs),
            below_floor: payload.length < this.finalMinBytes,
            ...(this.logContext ?? {}),
        }, 'stt final flush forced');
        const lineage = [...this.utteranceLineage];
        if (trimmedFrames.length !== this.utteranceFrames.length) {
            lineage.push('trim:trailing_silence');
        }
        this.enqueueTranscription(payload, {
            reason: 'final',
            isFinal: true,
            finalReason: reason,
            lineage,
        });
        this.resetUtteranceState();
    }
    concatFrames(frames) {
        if (frames.length === 1)
            return frames[0].buffer;
        return Buffer.concat(frames.map((f) => f.buffer));
    }
    abortInFlight(reason) {
        if (!this.inFlight) {
            return;
        }
        if (this.inFlightAbort) {
            this.inFlightAbort.abort();
            this.inFlightAbort = undefined;
        }
        this.inFlight = false;
        this.inFlightKind = undefined;
        this.finalizeToResultTimer = undefined;
        this.finalFlushAt = 0;
        this.inFlightToken += 1;
        if (reason === 'barge_in') {
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
    }
    enqueueTranscription(payload, meta) {
        if (this.inFlight)
            return;
        this.inFlight = true;
        this.inFlightKind = meta.reason;
        const token = (this.inFlightToken += 1);
        this.inFlightAbort = new AbortController();
        if (meta.isFinal) {
            this.finalizeToResultTimer = (0, metrics_1.startStageTimer)('stt_finalize_to_result_ms', this.tenantLabel);
        }
        void this.transcribePayload(payload, meta, token, this.inFlightAbort.signal)
            .catch((err) => {
            log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt transcription failed');
        })
            .finally(() => {
            if (this.inFlightToken !== token) {
                return;
            }
            this.inFlight = false;
            this.inFlightKind = undefined;
            this.inFlightAbort = undefined;
            this.finalizeToResultTimer = undefined;
        });
    }
    async transcribePayload(payload, meta, token, signal) {
        const startedAt = Date.now();
        const audioInput = this.provider.id === 'http_wav_json'
            ? {
                audio: payload,
                sampleRateHz: this.sampleRate,
                encoding: 'wav',
                channels: 1,
            }
            : {
                audio: payload,
                sampleRateHz: this.sampleRate,
                encoding: 'pcm16le',
                channels: 1,
            };
        const audioMeta = this.buildAudioMeta({
            format: audioInput.encoding === 'wav' ? 'wav' : 'pcm16le',
            sampleRateHz: audioInput.sampleRateHz,
            channels: 1,
            bitDepth: 16,
            lineage: meta.lineage ?? [],
            kind: meta.reason,
        });
        (0, audioProbe_1.markAudioSpan)('stt_submit', audioMeta);
        const endStt = (0, metrics_1.startStageTimer)('stt', this.tenantLabel);
        try {
            const result = await this.provider.transcribe(audioInput, {
                language: this.language,
                isPartial: meta.reason === 'partial',
                endpointUrl: this.whisperUrl,
                logContext: this.logContext,
                signal,
                audioMeta,
            });
            endStt();
            if (token !== this.inFlightToken) {
                return;
            }
            if (meta.isFinal && this.finalizeToResultTimer) {
                this.finalizeToResultTimer();
                this.finalizeToResultTimer = undefined;
            }
            const elapsedMs = Date.now() - startedAt;
            const text = normalizeWhitespace(result.text ?? '');
            (0, audioProbe_1.markAudioSpan)('stt_result', audioMeta);
            log_1.log.info({
                event: 'stt_transcription_result',
                kind: meta.reason,
                elapsed_ms: elapsedMs,
                text_len: text.length,
                ...(this.logContext ?? {}),
            }, 'stt transcription result');
            if (!text) {
                // If final came back empty, reset state
                if (meta.isFinal) {
                    this.resetUtteranceState();
                }
                return;
            }
            if (meta.reason === 'partial') {
                // De-dupe rapid repeats
                if (text === this.lastPartialTranscript)
                    return;
                this.lastPartialTranscript = text;
                if (isNonEmpty(text)) {
                    this.lastNonEmptyPartialAt = Date.now();
                    this.onTranscript(text, 'partial_fallback');
                }
                return;
            }
            // Final
            if (!this.finalTranscriptAccepted) {
                this.finalTranscriptAccepted = true;
                this.onTranscript(text, 'final');
            }
            this.resetUtteranceState();
        }
        catch (error) {
            endStt();
            if (signal.aborted || isAbortError(error)) {
                return;
            }
            if (token === this.inFlightToken && meta.isFinal) {
                this.finalizeToResultTimer = undefined;
            }
            (0, metrics_1.incStageError)('stt', this.tenantLabel);
            throw error;
        }
    }
    resetUtteranceState() {
        this.inSpeech = false;
        this.speechMs = 0;
        this.silenceMsAccum = 0;
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.utteranceFrames = [];
        this.utteranceLineage = [];
        this.speechFrameStreak = 0;
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.lastPartialTranscript = '';
        this.lastNonEmptyPartialAt = 0;
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.lastSpeechAt = 0;
    }
}
exports.ChunkedSTT = ChunkedSTT;
//# sourceMappingURL=chunkedSTT.js.map