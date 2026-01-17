"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallSession = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../env");
const log_1 = require("../log");
const wavInfo_1 = require("../audio/wavInfo");
const playbackPipeline_1 = require("../audio/playbackPipeline");
const audioStore_1 = require("../storage/audioStore");
const chunkedSTT_1 = require("../stt/chunkedSTT");
const registry_1 = require("../stt/registry");
const pstnTelnyxTransport_1 = require("../transport/pstnTelnyxTransport");
const kokoroTTS_1 = require("../tts/kokoroTTS");
const audioProbe_1 = require("../diagnostics/audioProbe");
const brainClient_1 = require("../ai/brainClient");
const metrics_1 = require("../metrics");
const PARTIAL_FAST_PATH_MIN_CHARS = 18;
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown_error';
}
function resolveDebugDir() {
    const dir = process.env.STT_DEBUG_DIR;
    return dir && dir.trim() !== '' ? dir.trim() : '/tmp/veralux-stt-debug';
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
function encodePcm16Wav(pcm16le, sampleRateHz) {
    const header = wavHeader(pcm16le.length, sampleRateHz, 1);
    return Buffer.concat([header, pcm16le]);
}
class CallSession {
    constructor(config) {
        this.state = 'INIT';
        this.transcriptBuffer = [];
        this.conversationHistory = [];
        this.deadAirMs = env_1.env.DEAD_AIR_MS;
        this.deadAirNoFramesMs = env_1.env.DEAD_AIR_NO_FRAMES_MS;
        this.active = true;
        this.isHandlingTranscript = false;
        this.hasStarted = false;
        this.turnSequence = 0;
        this.repromptInFlight = false;
        this.ingestFailurePrompted = false;
        this.logPreviewChars = 160;
        this.ttsSegmentChain = Promise.resolve();
        this.ttsSegmentQueueDepth = 0;
        this.playbackState = {
            active: false,
            interrupted: false,
        };
        this.transcriptHandlingToken = 0;
        this.transcriptAcceptedForUtterance = false;
        this.lastSpeechStartAtMs = 0;
        this.lastDecodedFrameAtMs = 0;
        this.rxDumpActive = false;
        this.rxDumpSamplesTarget = 0;
        this.rxDumpSamplesCollected = 0;
        this.rxDumpBuffers = [];
        this.listeningSinceAtMs = 0;
        // pick reasonable defaults; you can env-ize later
        this.deadAirListeningGraceMs = 1200; // prevents immediate reprompt right after enter LISTENING
        this.deadAirAfterSpeechStartGraceMs = 1500; // prevents reprompt while user has started speaking but transcript not ready
        this.callControlId = config.callControlId;
        this.tenantId = config.tenantId;
        this.from = config.from;
        this.to = config.to;
        this.requestId = config.requestId;
        this.metrics = {
            createdAt: new Date(),
            lastHeardAt: undefined,
            turns: 0,
        };
        this.sttConfig = config.tenantConfig?.stt;
        this.ttsConfig = config.tenantConfig?.tts;
        this.logContext = {
            call_control_id: this.callControlId,
            tenant_id: this.tenantId,
            requestId: this.requestId,
            telnyx_track: env_1.env.TELNYX_STREAM_TRACK,
        };
        this.transport =
            config.transportSession ??
                new pstnTelnyxTransport_1.PstnTelnyxTransportSession({
                    callControlId: this.callControlId,
                    tenantId: this.tenantId,
                    requestId: this.requestId,
                    isActive: () => this.active && this.state !== 'ENDED',
                });
        // ✅ Ensure this is ALWAYS a string (tenant override → env fallback)
        const sttEndpointUrl = this.sttConfig?.config?.url ??
            this.sttConfig?.whisperUrl ??
            env_1.env.WHISPER_URL;
        const sttMode = this.sttConfig?.mode ?? 'whisper_http';
        const provider = (0, registry_1.getProvider)(sttMode);
        const selectedMode = sttMode === 'http_wav_json' && !env_1.env.ALLOW_HTTP_WAV_JSON ? 'whisper_http' : sttMode;
        log_1.log.info({
            event: 'stt_provider_selected',
            call_control_id: this.callControlId,
            stt_mode: selectedMode,
            requested_mode: sttMode,
            provider_id: provider.id,
            ...(this.logContext ?? {}),
        }, 'stt provider selected');
        const sttAudioInput = this.transport.mode === 'pstn'
            ? { codec: 'pcm16le', sampleRateHz: env_1.env.TELNYX_TARGET_SAMPLE_RATE }
            : this.transport.audioInput;
        this.rxSampleRateHz = sttAudioInput.sampleRateHz;
        this.stt = new chunkedSTT_1.ChunkedSTT({
            provider,
            whisperUrl: sttEndpointUrl,
            language: this.sttConfig?.language,
            frameMs: this.sttConfig?.chunkMs ?? env_1.env.STT_CHUNK_MS,
            silenceEndMs: env_1.env.STT_SILENCE_MS,
            inputCodec: sttAudioInput.codec,
            sampleRate: sttAudioInput.sampleRateHz,
            onTranscript: async (text, source) => {
                await this.handleTranscript(text, source);
            },
            onSpeechStart: (info) => {
                void this.handleSpeechStart(info);
            },
            isPlaybackActive: () => this.isPlaybackActive(),
            isListening: () => this.isListening(),
            getTrack: () => env_1.env.TELNYX_STREAM_TRACK,
            getCodec: () => this.transport.audioInput.codec,
            logContext: this.logContext,
        });
    }
    start(options = {}) {
        if (!this.active || this.state === 'ENDED' || this.hasStarted) {
            return false;
        }
        this.state = 'INIT';
        this.hasStarted = true;
        if (options.autoAnswer !== false) {
            void this.answerAndGreet();
        }
        return true;
    }
    onAnswered() {
        if (!this.active || this.state === 'ENDED') {
            return false;
        }
        const previousState = this.state;
        if (this.state === 'INIT') {
            this.state = 'ANSWERED';
        }
        this.metrics.lastHeardAt = new Date();
        return previousState !== this.state;
    }
    onAudioFrame(frame) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.lastDecodedFrameAtMs = Date.now();
        if (this.state === 'INIT' || this.state === 'ANSWERED') {
            this.enterListeningState();
        }
        else if (this.state === 'LISTENING') {
            this.scheduleDeadAirTimer();
        }
        this.metrics.lastHeardAt = new Date();
        // Never gate STT audio feed on playback state; transcript handling is gated separately.
        (0, metrics_1.incSttFramesFed)();
        this.maybeCaptureRxDump(frame);
        this.stt.ingest(frame);
    }
    onPcm16Frame(frame) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.lastDecodedFrameAtMs = Date.now();
        if (this.state === 'INIT' || this.state === 'ANSWERED') {
            this.enterListeningState();
        }
        this.metrics.lastHeardAt = new Date();
        if (frame.sampleRateHz !== this.rxSampleRateHz) {
            log_1.log.warn({
                event: 'stt_sample_rate_mismatch',
                expected_hz: this.rxSampleRateHz,
                got_hz: frame.sampleRateHz,
                ...this.logContext,
            }, 'stt sample rate mismatch');
        }
        const pcmBuffer = Buffer.from(frame.pcm16.buffer, frame.pcm16.byteOffset, frame.pcm16.byteLength);
        (0, metrics_1.incSttFramesFed)();
        this.maybeCaptureRxDump(pcmBuffer);
        this.stt.ingestPcm16(frame.pcm16, frame.sampleRateHz);
    }
    isPlaybackActive() {
        if (!this.active || this.state === 'ENDED') {
            return false;
        }
        return this.playbackState.active || this.state === 'SPEAKING' || this.ttsSegmentQueueDepth > 0;
    }
    isListening() {
        return this.state === 'LISTENING';
    }
    getLastSpeechStartAtMs() {
        return this.lastSpeechStartAtMs;
    }
    notifyIngestFailure(reason) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        if (this.ingestFailurePrompted || this.repromptInFlight) {
            return;
        }
        this.ingestFailurePrompted = true;
        this.repromptInFlight = true;
        this.stt.stop();
        const turnId = `ingest-${this.nextTurnId()}`;
        log_1.log.warn({ event: 'call_session_ingest_failure_prompt', reason, ...this.logContext }, 'ingest failure prompt');
        void this.playText("I'm having trouble hearing you. Please try again.", turnId)
            .catch((error) => {
            log_1.log.warn({ err: error, ...this.logContext }, 'ingest failure reprompt failed');
        })
            .finally(() => {
            this.repromptInFlight = false;
            if (this.state === 'LISTENING') {
                this.scheduleDeadAirTimer();
            }
        });
    }
    end() {
        if (this.state === 'ENDED') {
            this.markEnded('ended');
            return false;
        }
        this.markEnded('ended');
        this.state = 'ENDED';
        this.metrics.lastHeardAt = new Date();
        this.clearDeadAirTimer();
        this.stt.stop();
        return true;
    }
    getState() {
        return this.state;
    }
    getTransport() {
        return this.transport;
    }
    isActive() {
        return this.active;
    }
    markEnded(reason) {
        if (!this.active) {
            if (!this.endedReason) {
                this.endedReason = reason;
            }
            return;
        }
        this.active = false;
        this.endedAt = Date.now();
        this.endedReason = reason;
        log_1.log.info({ event: 'call_marked_inactive', reason, ...this.logContext }, 'call marked inactive');
    }
    getEndInfo() {
        return {
            endedAt: this.endedAt,
            endedReason: this.endedReason,
        };
    }
    getMetrics() {
        return {
            createdAt: new Date(this.metrics.createdAt),
            lastHeardAt: this.metrics.lastHeardAt ? new Date(this.metrics.lastHeardAt) : undefined,
            turns: this.metrics.turns,
        };
    }
    getLastActivityAt() {
        return this.metrics.lastHeardAt ?? this.metrics.createdAt;
    }
    appendTranscriptSegment(segment) {
        if (segment.trim() === '') {
            return;
        }
        this.transcriptBuffer.push(segment);
    }
    appendHistory(turn) {
        this.conversationHistory.push(turn);
        this.metrics.turns += 1;
    }
    onPlaybackEnded() {
        if (this.playbackState.interrupted) {
            log_1.log.info({ event: 'playback_ended_ignored', reason: 'barge_in', ...this.logContext }, 'playback ended after barge-in');
            return;
        }
        if (!this.playbackState.active) {
            return;
        }
        this.playbackState.active = false;
        this.playbackState.segmentId = undefined;
        this.playbackStopSignal = undefined;
        if (this.active && this.state === 'SPEAKING') {
            this.enterListeningState();
        }
        if (this.active && this.state === 'LISTENING') {
            this.flushDeferredTranscript();
        }
        this.startRxDumpAfterPlayback();
    }
    createPlaybackStopSignal() {
        let resolve;
        const promise = new Promise((resolver) => {
            resolve = resolver;
        });
        return { promise, resolve: resolve };
    }
    beginPlayback(segmentId) {
        if (!this.playbackState.active) {
            this.playbackStopSignal = this.createPlaybackStopSignal();
        }
        this.playbackState.active = true;
        this.playbackState.interrupted = false;
        this.playbackState.segmentId = segmentId;
        this.state = 'SPEAKING';
        this.clearDeadAirTimer();
        this.resetRxDump();
    }
    resolvePlaybackStopSignal() {
        if (this.playbackStopSignal) {
            this.playbackStopSignal.resolve();
            this.playbackStopSignal = undefined;
        }
    }
    clearTtsQueue() {
        this.ttsSegmentChain = Promise.resolve();
        this.ttsSegmentQueueDepth = 0;
    }
    invalidateTranscriptHandling() {
        this.transcriptHandlingToken += 1;
        this.isHandlingTranscript = false;
    }
    flushDeferredTranscript() {
        if (!this.deferredTranscript) {
            return;
        }
        if (!this.active || this.state !== 'LISTENING' || this.isHandlingTranscript) {
            return;
        }
        const deferred = this.deferredTranscript;
        this.deferredTranscript = undefined;
        void this.handleTranscript(deferred.text, deferred.source);
    }
    logTtsBytesReady(id, audio, contentType) {
        const header = (0, wavInfo_1.describeWavHeader)(audio);
        log_1.log.info({
            event: 'tts_bytes_ready',
            id,
            bytes: audio.length,
            riff: header.riff,
            wave: header.wave,
            ...this.logContext,
        }, 'tts bytes ready');
        if (!header.riff || !header.wave) {
            log_1.log.warn({
                event: 'tts_non_wav_warning',
                id,
                content_type: contentType,
                first16_hex: header.first16Hex,
                bytes: audio.length,
                ...this.logContext,
            }, 'tts bytes are not wav');
        }
        const audioLogContext = { ...this.logContext, tts_id: id };
        const baseMeta = {
            callId: this.callControlId,
            tenantId: this.tenantId,
            format: 'wav',
            logContext: audioLogContext,
            lineage: ['tts:output'],
            kind: id,
        };
        (0, audioProbe_1.attachAudioMeta)(audio, baseMeta);
        (0, audioProbe_1.probeWav)('tts.out.raw', audio, baseMeta);
        this.logWavInfo('kokoro', id, audio);
    }
    logWavInfo(source, id, audio) {
        try {
            const info = (0, wavInfo_1.parseWavInfo)(audio);
            log_1.log.info({
                event: 'wav_info',
                source,
                id,
                sample_rate_hz: info.sampleRateHz,
                channels: info.channels,
                bits_per_sample: info.bitsPerSample,
                data_bytes: info.dataBytes,
                duration_ms: info.durationMs,
                ...this.logContext,
            }, 'wav info');
        }
        catch (error) {
            log_1.log.warn({
                event: 'wav_info_parse_failed',
                source,
                id,
                reason: getErrorMessage(error),
                ...this.logContext,
            }, 'wav info parse failed');
        }
    }
    resetTranscriptTracking() {
        this.transcriptAcceptedForUtterance = false;
        this.deferredTranscript = undefined;
        this.firstPartialAt = undefined;
    }
    shouldTriggerPartialFastPath(text) {
        const trimmed = text.trim();
        if (!trimmed)
            return false;
        if (/[.!?]$/.test(trimmed))
            return true;
        return trimmed.length >= PARTIAL_FAST_PATH_MIN_CHARS;
    }
    handleSpeechStart(info) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.lastSpeechStartAtMs = Date.now();
        this.resetTranscriptTracking();
        const playbackActive = this.playbackState.active || this.state === 'SPEAKING' || this.ttsSegmentQueueDepth > 0;
        if (!playbackActive || this.playbackState.interrupted) {
            return;
        }
        log_1.log.info({
            event: 'barge_in',
            reason: 'speech_start',
            state: this.state,
            speech_rms: info.rms,
            speech_peak: info.peak,
            speech_frame_ms: Math.round(info.frameMs),
            speech_frame_streak: info.streak,
            ...this.logContext,
        }, 'barge in');
        this.playbackState.active = false;
        this.playbackState.interrupted = true;
        this.playbackState.segmentId = undefined;
        this.resolvePlaybackStopSignal();
        this.clearTtsQueue();
        this.invalidateTranscriptHandling();
        this.enterListeningState();
        void this.stopPlayback();
    }
    async stopPlayback() {
        try {
            await this.transport.playback.stop();
        }
        catch (error) {
            log_1.log.warn({ err: error, ...this.logContext }, 'playback stop failed');
        }
    }
    enterListeningState() {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.state = 'LISTENING';
        this.listeningSinceAtMs = Date.now();
        this.scheduleDeadAirTimer();
    }
    scheduleDeadAirTimer() {
        if (!this.active || this.state !== 'LISTENING') {
            return;
        }
        this.clearDeadAirTimer();
        this.deadAirTimer = setTimeout(() => {
            void this.handleDeadAirTimeout();
        }, this.deadAirMs);
        this.deadAirTimer.unref?.();
    }
    clearDeadAirTimer() {
        if (this.deadAirTimer) {
            clearTimeout(this.deadAirTimer);
            this.deadAirTimer = undefined;
        }
    }
    startRxDumpAfterPlayback() {
        if (!env_1.env.STT_DEBUG_DUMP_RX_WAV) {
            return;
        }
        this.rxDumpActive = true;
        this.rxDumpSamplesTarget = Math.max(1, Math.round(this.rxSampleRateHz * 2));
        this.rxDumpSamplesCollected = 0;
        this.rxDumpBuffers = [];
    }
    resetRxDump() {
        this.rxDumpActive = false;
        this.rxDumpSamplesCollected = 0;
        this.rxDumpSamplesTarget = 0;
        this.rxDumpBuffers = [];
    }
    maybeCaptureRxDump(frame) {
        if (!this.rxDumpActive) {
            return;
        }
        const sampleCount = Math.floor(frame.length / 2);
        if (sampleCount <= 0) {
            return;
        }
        this.rxDumpBuffers.push(Buffer.from(frame));
        this.rxDumpSamplesCollected += sampleCount;
        if (this.rxDumpSamplesCollected >= this.rxDumpSamplesTarget) {
            void this.flushRxDump();
        }
    }
    async flushRxDump() {
        if (!this.rxDumpActive) {
            return;
        }
        this.rxDumpActive = false;
        const pcmBuffer = Buffer.concat(this.rxDumpBuffers);
        this.rxDumpBuffers = [];
        if (pcmBuffer.length === 0) {
            return;
        }
        const dir = resolveDebugDir();
        const filePath = path_1.default.join(dir, `rx_after_playback_${this.callControlId}_${Date.now()}.wav`);
        try {
            await fs_1.default.promises.mkdir(dir, { recursive: true });
            const wav = encodePcm16Wav(pcmBuffer, this.rxSampleRateHz);
            await fs_1.default.promises.writeFile(filePath, wav);
            log_1.log.info({
                event: 'stt_debug_rx_wav_written',
                file_path: filePath,
                sample_rate_hz: this.rxSampleRateHz,
                bytes: wav.length,
                ...this.logContext,
            }, 'stt debug rx wav written');
        }
        catch (error) {
            log_1.log.warn({ err: error, file_path: filePath, ...this.logContext }, 'stt debug rx wav write failed');
        }
    }
    async handleDeadAirTimeout() {
        if (!this.active || this.state !== 'LISTENING' || this.repromptInFlight) {
            return;
        }
        // If we're currently processing a transcript, don't reprompt.
        if (this.isHandlingTranscript) {
            this.scheduleDeadAirTimer();
            return;
        }
        const now = Date.now();
        // 1) Grace right after we enter LISTENING (prevents greet/playback -> listening race)
        if (this.listeningSinceAtMs > 0 && now - this.listeningSinceAtMs < this.deadAirListeningGraceMs) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 2) If we recently detected speech start, assume user is talking and STT is behind.
        if (this.lastSpeechStartAtMs > 0 && now - this.lastSpeechStartAtMs < this.deadAirAfterSpeechStartGraceMs) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 3) If we are still receiving frames recently, don't reprompt.
        // If frames are still arriving, do NOT treat this as "no-frames" dead air.
        if (this.lastDecodedFrameAtMs > 0 && now - this.lastDecodedFrameAtMs < this.deadAirNoFramesMs) {
            // frames are alive; just wait for next deadAirMs tick
            this.scheduleDeadAirTimer();
            return;
        }
        // 4) Extra safety: never reprompt if playback/tts is active (should already be true, but safe)
        if (this.isPlaybackActive()) {
            this.scheduleDeadAirTimer();
            return;
        }
        this.repromptInFlight = true;
        try {
            await this.playText('Are you still there?', `reprompt-${this.nextTurnId()}`);
            log_1.log.info({ event: 'call_session_reprompt', ...this.logContext }, 'dead air reprompt');
        }
        finally {
            this.repromptInFlight = false;
            if (this.state === 'LISTENING') {
                this.listeningSinceAtMs = Date.now(); // reset grace so it doesn't immediately fire again
                this.scheduleDeadAirTimer();
            }
        }
    }
    async handleTranscript(text, transcriptSource) {
        if (!this.active || this.state === 'ENDED' || this.isHandlingTranscript) {
            return;
        }
        const trimmed = text.trim();
        if (trimmed === '') {
            return;
        }
        const isPartial = transcriptSource === 'partial_fallback';
        const trigger = isPartial ? 'partial' : 'final';
        if (this.transcriptAcceptedForUtterance) {
            return;
        }
        if (isPartial && !this.firstPartialAt) {
            this.firstPartialAt = Date.now();
        }
        if (isPartial && !this.shouldTriggerPartialFastPath(trimmed)) {
            return;
        }
        const playbackActive = this.playbackState.active || this.ttsSegmentQueueDepth > 0;
        if (playbackActive && !this.playbackState.interrupted) {
            const existing = this.deferredTranscript;
            if (!existing || trigger === 'final' || existing.source !== 'final') {
                this.deferredTranscript = { text: trimmed, source: transcriptSource };
            }
            log_1.log.info({
                event: 'transcript_deferred_playback',
                trigger,
                transcript_length: trimmed.length,
                state: this.state,
                playback_active: this.playbackState.active,
                tts_queue_depth: this.ttsSegmentQueueDepth,
                ...this.logContext,
            }, 'transcript deferred during playback');
            return;
        }
        const tenantLabel = this.tenantId ?? 'unknown';
        const responseStartAt = Date.now();
        if (isPartial && this.firstPartialAt) {
            (0, metrics_1.observeStageDuration)('stt_first_partial_to_response_ms', tenantLabel, responseStartAt - this.firstPartialAt);
        }
        else if (!isPartial) {
            (0, metrics_1.observeStageDuration)('stt_final_to_response_ms', tenantLabel, 0);
        }
        log_1.log.info({
            event: 'turn_trigger',
            trigger,
            transcript_length: trimmed.length,
            ...this.logContext,
        }, 'turn trigger');
        this.transcriptAcceptedForUtterance = true;
        this.isHandlingTranscript = true;
        const handlingToken = (this.transcriptHandlingToken += 1);
        this.clearDeadAirTimer();
        try {
            const transcriptPreview = trimmed.length <= this.logPreviewChars
                ? trimmed
                : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;
            const transcriptLog = {
                event: 'transcript_received',
                transcript_length: trimmed.length,
                transcript_preview: transcriptPreview,
                ...this.logContext,
            };
            if (transcriptSource === 'partial_fallback') {
                transcriptLog.transcript_source = transcriptSource;
            }
            log_1.log.info(transcriptLog, 'transcript received');
            this.state = 'THINKING';
            this.appendTranscriptSegment(trimmed);
            this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });
            let response = '';
            let replySource = 'unknown';
            let playbackDone;
            try {
                if (env_1.env.BRAIN_STREAMING_ENABLED) {
                    // LLM stage timing for streaming is handled inside streamAssistantReply()
                    const streamResult = await this.streamAssistantReply(trimmed, handlingToken);
                    response = streamResult.reply.text;
                    replySource = streamResult.reply.source;
                    playbackDone = streamResult.playbackDone;
                }
                else {
                    const endLlm = (0, metrics_1.startStageTimer)('llm', tenantLabel);
                    try {
                        const reply = await (0, brainClient_1.generateAssistantReply)({
                            tenantId: this.tenantId,
                            callControlId: this.callControlId,
                            transcript: trimmed,
                            history: this.conversationHistory,
                        });
                        endLlm();
                        response = reply.text;
                        replySource = reply.source;
                    }
                    catch (error) {
                        (0, metrics_1.incStageError)('llm', tenantLabel);
                        endLlm();
                        throw error; // let your existing outer catch handle fallback response/logging
                    }
                }
            }
            catch (error) {
                response = 'Acknowledged.';
                replySource = 'fallback_error';
                log_1.log.error({ err: error, assistant_reply_source: replySource, ...this.logContext }, 'assistant reply generation failed');
            }
            if (handlingToken !== this.transcriptHandlingToken) {
                return;
            }
            (0, audioProbe_1.markAudioSpan)('llm_result', {
                callId: this.callControlId,
                tenantId: this.tenantId,
                logContext: this.logContext,
            });
            const replyPreview = response.length <= this.logPreviewChars
                ? response
                : `${response.slice(0, this.logPreviewChars - 3)}...`;
            log_1.log.info({
                event: 'assistant_reply_text',
                assistant_reply_text: replyPreview,
                assistant_reply_length: response.length,
                assistant_reply_source: replySource,
                ...this.logContext,
            }, 'assistant reply text');
            if (handlingToken !== this.transcriptHandlingToken) {
                return;
            }
            this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
            if (env_1.env.BRAIN_STREAMING_ENABLED) {
                if (playbackDone) {
                    await playbackDone;
                }
            }
            else {
                await this.playAssistantTurn(response);
            }
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
        }
        finally {
            if (handlingToken === this.transcriptHandlingToken) {
                // FIX (TS2367): call unconditionally; enterListeningState guards ENDED internally.
                this.enterListeningState();
                this.isHandlingTranscript = false;
            }
        }
    }
    async streamAssistantReply(transcript, handlingToken) {
        let bufferedText = '';
        let firstTokenAt;
        let speakCursor = 0;
        let firstSegmentQueued = false;
        let segmentIndex = 0;
        let queuedSegments = 0;
        let baseTurnId;
        const firstSegmentMin = env_1.env.BRAIN_STREAM_SEGMENT_MIN_CHARS;
        const nextSegmentMin = env_1.env.BRAIN_STREAM_SEGMENT_NEXT_CHARS;
        const firstAudioMaxMs = env_1.env.BRAIN_STREAM_FIRST_AUDIO_MAX_MS;
        const queueSegment = (segment) => {
            if (handlingToken !== this.transcriptHandlingToken) {
                return;
            }
            const trimmed = segment.trim();
            if (!trimmed) {
                return;
            }
            const resolvedTurnId = baseTurnId ?? `turn-${this.nextTurnId()}`;
            baseTurnId = resolvedTurnId;
            segmentIndex += 1;
            queuedSegments += 1;
            const segmentId = `${resolvedTurnId}-${segmentIndex}`;
            this.queueTtsSegment(trimmed, segmentId, handlingToken);
        };
        const maybeQueueSegments = (force) => {
            if (!this.active) {
                return;
            }
            while (true) {
                const pending = bufferedText.slice(speakCursor);
                if (!pending) {
                    return;
                }
                if (!firstSegmentQueued) {
                    const boundary = this.findSentenceBoundary(pending);
                    if (boundary !== null) {
                        queueSegment(pending.slice(0, boundary));
                        speakCursor += boundary;
                        firstSegmentQueued = true;
                        continue;
                    }
                    if (pending.length >= firstSegmentMin) {
                        const end = this.selectSegmentEnd(pending, firstSegmentMin);
                        queueSegment(pending.slice(0, end));
                        speakCursor += end;
                        firstSegmentQueued = true;
                        continue;
                    }
                    if (force ||
                        (firstTokenAt && Date.now() - firstTokenAt >= firstAudioMaxMs)) {
                        queueSegment(pending);
                        speakCursor += pending.length;
                        firstSegmentQueued = true;
                        continue;
                    }
                    return;
                }
                const boundary = this.findSentenceBoundary(pending);
                if (boundary !== null) {
                    queueSegment(pending.slice(0, boundary));
                    speakCursor += boundary;
                    continue;
                }
                if (pending.length >= nextSegmentMin) {
                    const end = this.selectSegmentEnd(pending, nextSegmentMin);
                    queueSegment(pending.slice(0, end));
                    speakCursor += end;
                    continue;
                }
                if (force) {
                    queueSegment(pending);
                    speakCursor += pending.length;
                }
                return;
            }
        };
        const tenantLabel = this.tenantId ?? 'unknown';
        const endLlm = (0, metrics_1.startStageTimer)('llm', tenantLabel);
        let reply;
        try {
            reply = await (0, brainClient_1.generateAssistantReplyStream)({
                tenantId: this.tenantId,
                callControlId: this.callControlId,
                transcript,
                history: this.conversationHistory,
            }, (chunk) => {
                if (!chunk)
                    return;
                if (!firstTokenAt)
                    firstTokenAt = Date.now();
                bufferedText += chunk;
                maybeQueueSegments(false);
            });
            endLlm();
        }
        catch (error) {
            (0, metrics_1.incStageError)('llm', tenantLabel);
            endLlm();
            throw error;
        }
        if (handlingToken !== this.transcriptHandlingToken) {
            return { reply };
        }
        if (reply.source !== 'brain_http_stream') {
            if (handlingToken !== this.transcriptHandlingToken) {
                return { reply };
            }
            return { reply, playbackDone: this.playAssistantTurn(reply.text) };
        }
        if (reply.text.length > bufferedText.length) {
            bufferedText = reply.text;
        }
        maybeQueueSegments(true);
        if (queuedSegments === 0) {
            if (handlingToken !== this.transcriptHandlingToken) {
                return { reply };
            }
            return { reply, playbackDone: this.playAssistantTurn(reply.text) };
        }
        return { reply, playbackDone: this.waitForTtsSegmentQueue() };
    }
    async answerAndGreet() {
        try {
            const answerStarted = Date.now();
            if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('answer')) {
                return;
            }
            await this.transport.start();
            const answerDuration = Date.now() - answerStarted;
            if (this.transport.mode === 'pstn') {
                log_1.log.info({ event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext }, 'telnyx answer completed');
            }
            log_1.log.info({ event: 'call_answered', ...this.logContext }, 'call answered');
            this.onAnswered();
            if (this.transport.mode === 'webrtc_hd') {
                await this.playText('Hi! Thanks for calling. How can I help you today?', 'greeting');
                return;
            }
            const trimmedBaseUrl = env_1.env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
            const greetingUrl = `${trimmedBaseUrl}/greeting.wav`;
            if (this.shouldSkipTelnyxAction('playback_start')) {
                return;
            }
            this.beginPlayback('greeting');
            await this.transport.playback.play({ kind: 'url', url: greetingUrl });
            log_1.log.info({ event: 'call_playback_started', audio_url: greetingUrl, ...this.logContext }, 'playback started');
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call start greeting failed');
        }
    }
    async playAssistantTurn(text) {
        const turnId = `turn-${this.nextTurnId()}`;
        await this.playText(text, turnId);
    }
    async playText(text, turnId) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.beginPlayback(turnId);
        try {
            const tenantLabel = this.tenantId ?? 'unknown';
            const endTts = (0, metrics_1.startStageTimer)('tts', tenantLabel);
            const spanMeta = {
                callId: this.callControlId,
                tenantId: this.tenantId,
                logContext: { ...this.logContext, tts_id: turnId },
                kind: turnId,
            };
            (0, audioProbe_1.markAudioSpan)('tts_start', spanMeta);
            const ttsStart = Date.now();
            let result;
            try {
                result = await (0, kokoroTTS_1.synthesizeSpeech)({
                    text,
                    voice: this.ttsConfig?.voice,
                    format: this.ttsConfig?.format,
                    sampleRate: this.ttsConfig?.sampleRate,
                    kokoroUrl: this.ttsConfig?.kokoroUrl,
                });
            }
            catch (error) {
                (0, metrics_1.incStageError)('tts', tenantLabel);
                throw error;
            }
            finally {
                endTts();
            }
            const ttsDuration = Date.now() - ttsStart;
            (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
            log_1.log.info({
                event: 'tts_synthesized',
                duration_ms: ttsDuration,
                audio_bytes: result.audio.length,
                ...this.logContext,
            }, 'tts synthesized');
            if (!this.active || this.playbackState.interrupted) {
                return;
            }
            this.logTtsBytesReady(turnId, result.audio, result.contentType);
            let playbackAudio = result.audio;
            const applyPstnPipeline = env_1.env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
            if (applyPstnPipeline) {
                const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', tenantLabel);
                const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(playbackAudio, {
                    targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                    enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                    logContext: this.logContext,
                });
                endPipeline();
                playbackAudio = pipelineResult.audio;
            }
            if (applyPstnPipeline) {
                this.logWavInfo('pipeline_output', turnId, playbackAudio);
                const pipelineMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                    format: 'wav',
                    logContext: { ...this.logContext, tts_id: turnId },
                    lineage: ['pipeline:unknown'],
                };
                (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
            }
            result.audio = playbackAudio;
            const playbackInput = this.transport.mode === 'pstn'
                ? { kind: 'url', url: await (0, audioStore_1.storeWav)(this.callControlId, turnId, result.audio) }
                : { kind: 'buffer', audio: result.audio, contentType: result.contentType };
            if (this.playbackState.interrupted) {
                return;
            }
            if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('playback_start')) {
                return;
            }
            const playbackStage = this.transport.mode === 'pstn' ? 'telnyx_playback' : 'webrtc_playback_ms';
            const endPlayback = (0, metrics_1.startStageTimer)(playbackStage, tenantLabel);
            const playbackStart = Date.now();
            try {
                if (this.transport.mode === 'pstn') {
                    const txMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                        format: 'wav',
                        logContext: { ...this.logContext, tts_id: turnId },
                        lineage: ['tx:unknown'],
                    };
                    (0, audioProbe_1.probeWav)('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: turnId });
                }
                (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
                await this.transport.playback.play(playbackInput);
            }
            catch (error) {
                (0, metrics_1.incStageError)(playbackStage, tenantLabel);
                throw error;
            }
            finally {
                endPlayback();
            }
            const playbackDuration = Date.now() - playbackStart;
            if (this.transport.mode === 'pstn') {
                log_1.log.info({
                    event: 'telnyx_playback_duration',
                    duration_ms: playbackDuration,
                    audio_url: playbackInput.url,
                    ...this.logContext,
                }, 'telnyx playback completed');
            }
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session tts playback failed');
        }
        finally {
            // FIX (TS2367): call unconditionally; enterListeningState guards ENDED internally.
            this.enterListeningState();
        }
    }
    queueTtsSegment(segmentText, segmentId, handlingToken) {
        if (!segmentText.trim()) {
            return;
        }
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        if (handlingToken !== undefined && handlingToken !== this.transcriptHandlingToken) {
            return;
        }
        this.beginPlayback(segmentId);
        this.ttsSegmentQueueDepth += 1;
        const queueDepth = this.ttsSegmentQueueDepth;
        log_1.log.info({
            event: 'tts_segment_queued',
            seg_len: segmentText.length,
            queue_depth: queueDepth,
            segment_id: segmentId,
            ...this.logContext,
        }, 'tts segment queued');
        this.ttsSegmentChain = this.ttsSegmentChain
            .then(async () => {
            await this.playTtsSegment(segmentText, segmentId);
        })
            .catch((error) => {
            log_1.log.error({ err: error, ...this.logContext }, 'tts segment playback failed');
        })
            .finally(() => {
            this.ttsSegmentQueueDepth = Math.max(0, this.ttsSegmentQueueDepth - 1);
        });
    }
    async playTtsSegment(segmentText, segmentId) {
        const shouldAbort = !this.active || this.state === 'ENDED' || this.playbackState.interrupted;
        if (shouldAbort) {
            return;
        }
        const tenantLabel = this.tenantId ?? 'unknown';
        const endTts = (0, metrics_1.startStageTimer)('tts', tenantLabel);
        const spanMeta = {
            callId: this.callControlId,
            tenantId: this.tenantId,
            logContext: { ...this.logContext, tts_id: segmentId },
            kind: segmentId,
        };
        (0, audioProbe_1.markAudioSpan)('tts_start', spanMeta);
        const ttsStart = Date.now();
        let result;
        try {
            result = await (0, kokoroTTS_1.synthesizeSpeech)({
                text: segmentText,
                voice: this.ttsConfig?.voice,
                format: this.ttsConfig?.format,
                sampleRate: this.ttsConfig?.sampleRate,
                kokoroUrl: this.ttsConfig?.kokoroUrl,
            });
        }
        catch (error) {
            (0, metrics_1.incStageError)('tts', tenantLabel);
            throw error;
        }
        finally {
            endTts();
        }
        const ttsDuration = Date.now() - ttsStart;
        (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
        log_1.log.info({
            event: 'tts_synthesized',
            duration_ms: ttsDuration,
            audio_bytes: result.audio.length,
            ...this.logContext,
        }, 'tts synthesized');
        if (!this.active || this.state === 'ENDED' || this.playbackState.interrupted) {
            return;
        }
        this.logTtsBytesReady(segmentId, result.audio, result.contentType);
        let playbackAudio = result.audio;
        const applyPstnPipeline = env_1.env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
        if (applyPstnPipeline) {
            const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', tenantLabel);
            const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(playbackAudio, {
                targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                logContext: this.logContext,
            });
            endPipeline();
            playbackAudio = pipelineResult.audio;
        }
        if (applyPstnPipeline) {
            this.logWavInfo('pipeline_output', segmentId, playbackAudio);
            const pipelineMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                format: 'wav',
                logContext: { ...this.logContext, tts_id: segmentId },
                lineage: ['pipeline:unknown'],
            };
            (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
        }
        result.audio = playbackAudio;
        const playbackInput = this.transport.mode === 'pstn'
            ? { kind: 'url', url: await (0, audioStore_1.storeWav)(this.callControlId, segmentId, result.audio) }
            : { kind: 'buffer', audio: result.audio, contentType: result.contentType };
        if (this.playbackState.interrupted) {
            return;
        }
        if (this.transport.mode === 'pstn') {
            log_1.log.info({
                event: 'tts_segment_play_start',
                seg_len: segmentText.length,
                segment_id: segmentId,
                audio_url: playbackInput.url,
                ...this.logContext,
            }, 'tts segment playback start');
        }
        const playbackStage = this.transport.mode === 'pstn' ? 'telnyx_playback' : 'webrtc_playback_ms';
        const endPlayback = (0, metrics_1.startStageTimer)(playbackStage, tenantLabel);
        const playbackStart = Date.now();
        try {
            if (this.transport.mode === 'pstn') {
                const txMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                    format: 'wav',
                    logContext: { ...this.logContext, tts_id: segmentId },
                    lineage: ['tx:unknown'],
                };
                (0, audioProbe_1.probeWav)('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: segmentId });
            }
            (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
            await this.transport.playback.play(playbackInput);
        }
        catch (error) {
            (0, metrics_1.incStageError)(playbackStage, tenantLabel);
            throw error;
        }
        finally {
            endPlayback();
        }
        const playbackDuration = Date.now() - playbackStart;
        if (this.transport.mode === 'pstn') {
            log_1.log.info({
                event: 'tts_segment_play_end',
                seg_len: segmentText.length,
                segment_id: segmentId,
                duration_ms: playbackDuration,
                audio_url: playbackInput.url,
                ...this.logContext,
            }, 'tts segment playback end');
        }
    }
    waitForTtsSegmentQueue() {
        if (!this.playbackStopSignal) {
            return this.ttsSegmentChain;
        }
        return Promise.race([this.ttsSegmentChain, this.playbackStopSignal.promise]);
    }
    findSentenceBoundary(text) {
        const match = text.match(/[.!?](?=\s|$)/);
        if (!match || match.index === undefined) {
            return null;
        }
        return match.index + 1;
    }
    selectSegmentEnd(text, targetChars) {
        if (text.length <= targetChars) {
            return text.length;
        }
        const slice = text.slice(0, targetChars);
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace >= Math.floor(targetChars * 0.6)) {
            return lastSpace;
        }
        return targetChars;
    }
    nextTurnId() {
        this.turnSequence += 1;
        return this.turnSequence;
    }
    shouldSkipTelnyxAction(action) {
        if (this.transport.mode !== 'pstn') {
            return false;
        }
        if (this.active) {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
exports.CallSession = CallSession;
//# sourceMappingURL=callSession.js.map