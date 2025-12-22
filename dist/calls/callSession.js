"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallSession = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
const audioStore_1 = require("../storage/audioStore");
const chunkedSTT_1 = require("../stt/chunkedSTT");
const telnyxClient_1 = require("../telnyx/telnyxClient");
const kokoroTTS_1 = require("../tts/kokoroTTS");
class CallSession {
    constructor(config) {
        this.state = 'INIT';
        this.transcriptBuffer = [];
        this.conversationHistory = [];
        this.deadAirMs = env_1.env.DEAD_AIR_MS;
        this.isHandlingTranscript = false;
        this.hasStarted = false;
        this.turnSequence = 0;
        this.repromptInFlight = false;
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
        this.logContext = {
            call_control_id: this.callControlId,
            tenant_id: this.tenantId,
            requestId: this.requestId,
        };
        this.telnyx = new telnyxClient_1.TelnyxClient(this.logContext);
        this.stt = new chunkedSTT_1.ChunkedSTT({
            chunkMs: env_1.env.STT_CHUNK_MS,
            silenceMs: env_1.env.STT_SILENCE_MS,
            onTranscript: async (text) => {
                await this.handleTranscript(text);
            },
            logContext: this.logContext,
        });
    }
    start(options = {}) {
        if (this.state === 'ENDED' || this.hasStarted) {
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
        if (this.state === 'ENDED') {
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
        if (this.state === 'ENDED') {
            return;
        }
        if (this.state === 'INIT' || this.state === 'ANSWERED') {
            this.enterListeningState();
        }
        else if (this.state === 'LISTENING') {
            this.scheduleDeadAirTimer();
        }
        this.metrics.lastHeardAt = new Date();
        if (this.state === 'LISTENING') {
            this.stt.ingest(frame);
        }
    }
    end() {
        if (this.state === 'ENDED') {
            return false;
        }
        this.state = 'ENDED';
        this.metrics.lastHeardAt = new Date();
        this.clearDeadAirTimer();
        this.stt.stop();
        return true;
    }
    getState() {
        return this.state;
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
    enterListeningState() {
        if (this.state === 'ENDED') {
            return;
        }
        this.state = 'LISTENING';
        this.scheduleDeadAirTimer();
    }
    scheduleDeadAirTimer() {
        if (this.state !== 'LISTENING') {
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
    async handleDeadAirTimeout() {
        if (this.state !== 'LISTENING' || this.state === 'ENDED' || this.repromptInFlight) {
            return;
        }
        if (this.isHandlingTranscript) {
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
                this.scheduleDeadAirTimer();
            }
        }
    }
    async handleTranscript(text) {
        if (this.state !== 'LISTENING' || this.isHandlingTranscript) {
            return;
        }
        this.isHandlingTranscript = true;
        this.clearDeadAirTimer();
        try {
            const trimmed = text.trim();
            if (trimmed === '') {
                return;
            }
            this.state = 'THINKING';
            this.appendTranscriptSegment(trimmed);
            this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });
            const response = await this.mockAiTurn(trimmed);
            this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
            await this.playAssistantTurn(response);
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
        }
        finally {
            if (this.state !== 'ENDED') {
                this.enterListeningState();
            }
            this.isHandlingTranscript = false;
        }
    }
    async mockAiTurn(transcript) {
        void transcript;
        return 'Acknowledged.';
    }
    async answerAndGreet() {
        try {
            const answerStarted = Date.now();
            await this.telnyx.answerCall(this.callControlId);
            const answerDuration = Date.now() - answerStarted;
            log_1.log.info({ event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext }, 'telnyx answer completed');
            this.onAnswered();
            await this.playText('Hello, thanks for calling.', 'greeting');
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
        if (this.state === 'ENDED') {
            return;
        }
        this.clearDeadAirTimer();
        this.state = 'SPEAKING';
        try {
            const ttsStart = Date.now();
            const result = await (0, kokoroTTS_1.synthesizeSpeech)({ text });
            const ttsDuration = Date.now() - ttsStart;
            log_1.log.info({ event: 'tts_synthesized', duration_ms: ttsDuration, audio_bytes: result.audio.length, ...this.logContext }, 'tts synthesized');
            const publicUrl = await (0, audioStore_1.storeWav)(this.callControlId, turnId, result.audio);
            const playbackStart = Date.now();
            await this.telnyx.playAudio(this.callControlId, publicUrl);
            const playbackDuration = Date.now() - playbackStart;
            log_1.log.info({
                event: 'telnyx_playback_duration',
                duration_ms: playbackDuration,
                audio_url: publicUrl,
                ...this.logContext,
            }, 'telnyx playback completed');
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session tts playback failed');
        }
        finally {
            if (this.state !== 'ENDED') {
                this.enterListeningState();
            }
        }
    }
    nextTurnId() {
        this.turnSequence += 1;
        return this.turnSequence;
    }
}
exports.CallSession = CallSession;
//# sourceMappingURL=callSession.js.map