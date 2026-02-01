"use strict";
// src/calls/callAudioCoordinator.ts
// How it works: owns per-call audio state + readiness gating, manages pre-roll buffering,
// and emits timing summaries once each utterance completes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallAudioCoordinator = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
const inboundRingBuffer_1 = require("../audio/inboundRingBuffer");
const MEDIA_READY_MIN_MS = 200;
const MEDIA_READY_MAX_GAP_MS = 300;
const PREROLL_DEFAULT_MS = 700;
const PREROLL_MIN_MS = 500;
const PREROLL_MAX_MS = 800;
class CallAudioCoordinator {
    constructor(options) {
        this.state = 'IDLE';
        this.wsConnected = false;
        this.firstInboundFrameSeen = false;
        this.mediaReady = false;
        this.mediaReadyConsecutiveMs = 0;
        this.lastInboundFrameAtMs = 0;
        this.wsConnectedAtMs = 0;
        this.firstFrameAtMs = 0;
        this.playbackEndedAtMs = 0;
        this.sttArmedAtMs = 0;
        this.utteranceStartAtMs = 0;
        this.preRollMs = 0;
        this.utteranceTotalMs = 0;
        this.speechMs = 0;
        this.trailingSilenceMs = 0;
        this.hangupReceivedAtMs = 0;
        this.sttReqStartAtMs = 0;
        this.sttReqEndAtMs = 0;
        this.ttsStartAtMs = 0;
        this.ttsEndAtMs = 0;
        this.sawSpeech = false;
        this.finalInFlight = false;
        this.summaryPending = false;
        this.callControlId = options.callControlId;
        this.logContext = options.logContext;
        this.isPlaybackActive = options.isPlaybackActive;
        this.isCallActive = options.isCallActive;
        this.canArmListening = options.canArmListening;
        this.isListening = options.isListening;
        this.onArmListening = options.onArmListening;
        const rawPreRoll = env_1.env.STT_PRE_ROLL_MS;
        const preRollMs = Math.min(PREROLL_MAX_MS, Math.max(PREROLL_MIN_MS, Math.floor(Number.isFinite(rawPreRoll) ? rawPreRoll : PREROLL_DEFAULT_MS)));
        this.ringBuffer = new inboundRingBuffer_1.InboundPcm16RingBuffer({
            sampleRateHz: options.sampleRateHz,
            maxMs: preRollMs,
        });
    }
    getState() {
        return this.state;
    }
    isEnding() {
        return this.state === 'ENDING';
    }
    isMediaReady() {
        return this.mediaReady;
    }
    setWsConnected(connected, ts = Date.now()) {
        this.wsConnected = connected;
        if (connected) {
            this.wsConnectedAtMs = ts;
        }
        else {
            this.firstInboundFrameSeen = false;
            this.mediaReadyConsecutiveMs = 0;
            this.lastInboundFrameAtMs = 0;
            this.ringBuffer.reset();
        }
        this.updateMediaReady(ts, true);
        this.maybeArmListening(connected ? 'ws_connected' : 'ws_disconnected', ts);
    }
    onInboundFrame(frame, ts = Date.now()) {
        if (!this.wsConnected || !this.isCallActive()) {
            return;
        }
        this.ringBuffer.push(frame.pcm16, frame.sampleRateHz);
        if (!this.firstInboundFrameSeen) {
            this.firstInboundFrameSeen = true;
            this.firstFrameAtMs = ts;
        }
        const frameMs = (frame.pcm16.length / frame.sampleRateHz) * 1000;
        if (Number.isFinite(frameMs) && frameMs > 0) {
            if (this.lastInboundFrameAtMs > 0) {
                const gapMs = ts - this.lastInboundFrameAtMs;
                if (gapMs > Math.max(MEDIA_READY_MAX_GAP_MS, frameMs * 4)) {
                    this.mediaReadyConsecutiveMs = 0;
                }
            }
            this.mediaReadyConsecutiveMs += frameMs;
            this.lastInboundFrameAtMs = ts;
        }
        const changed = this.updateMediaReady(ts);
        if (changed && this.mediaReady) {
            this.maybeArmListening('media_ready', ts);
        }
    }
    onPlaybackEnded(ts = Date.now(), reason = 'playback_ended') {
        this.playbackEndedAtMs = ts;
        if (this.ttsStartAtMs > 0 && this.ttsEndAtMs === 0) {
            this.ttsEndAtMs = ts;
        }
        this.maybeArmListening(reason, ts);
    }
    onTtsStart(ts = Date.now(), reason = 'tts_playback_start') {
        if (this.state !== 'ENDING') {
            this.transition('PLAYING', reason, ts);
        }
        if (this.ttsStartAtMs === 0) {
            this.ttsStartAtMs = ts;
            this.ttsEndAtMs = 0;
        }
    }
    notifyListeningEligibilityChanged(reason, ts = Date.now()) {
        this.maybeArmListening(reason, ts);
    }
    consumePreRollForUtterance() {
        return this.ringBuffer.snapshot();
    }
    onSpeechStart(prependedMs, ts = Date.now()) {
        if (this.state === 'ENDING')
            return;
        if (this.summaryPending) {
            this.emitTimingSummary(ts);
        }
        this.resetUtteranceTiming();
        this.sawSpeech = true;
        this.utteranceStartAtMs = ts;
        if (typeof prependedMs === 'number' && Number.isFinite(prependedMs)) {
            this.preRollMs = Math.max(0, Math.round(prependedMs));
        }
        // If we never transitioned to LISTENING (e.g. speech before media_ready), backfill so timing summary is meaningful.
        if (this.sttArmedAtMs === 0) {
            this.sttArmedAtMs = ts;
        }
        this.transition('CAPTURING', 'speech_start', ts);
    }
    onUtteranceEnd(info, ts = Date.now()) {
        if (this.state === 'ENDING')
            return;
        this.utteranceTotalMs = Math.max(0, Math.round(info.utteranceMs));
        this.speechMs = Math.max(0, Math.round(info.speechMs));
        this.trailingSilenceMs = Math.max(0, Math.round(info.trailingSilenceMs));
        if (Number.isFinite(info.preRollMs)) {
            this.preRollMs = Math.max(0, Math.round(info.preRollMs));
        }
        this.summaryPending = true;
        this.transition('FINALIZING_STT', 'utterance_end', ts);
    }
    onRespondingStart(ts = Date.now()) {
        if (this.state === 'ENDING')
            return;
        this.transition('RESPONDING', 'responding_start', ts);
    }
    onSttRequestStart(kind, ts = Date.now()) {
        if (kind !== 'final')
            return;
        this.finalInFlight = true;
        if (this.sttReqStartAtMs === 0)
            this.sttReqStartAtMs = ts;
        log_1.log.info({
            event: 'audio_stt_req_start',
            call_control_id: this.callControlId,
            kind,
            ts,
            ...(this.logContext ?? {}),
        }, 'audio stt request start');
    }
    onSttRequestEnd(kind, ts = Date.now()) {
        if (kind !== 'final')
            return;
        this.finalInFlight = false;
        this.sttReqEndAtMs = ts;
        log_1.log.info({
            event: 'audio_stt_req_end',
            call_control_id: this.callControlId,
            kind,
            ts,
            ...(this.logContext ?? {}),
        }, 'audio stt request end');
    }
    onHangup(ts = Date.now(), reason = 'hangup') {
        if (this.hangupReceivedAtMs === 0) {
            this.hangupReceivedAtMs = ts;
        }
        log_1.log.info({
            event: 'audio_hangup_received',
            call_control_id: this.callControlId,
            reason,
            ts,
            ...(this.logContext ?? {}),
        }, 'audio hangup received');
        this.transition('ENDING', reason, ts);
    }
    shouldFinalizeOnDisconnect() {
        const shouldFinalize = this.state === 'CAPTURING' || this.sawSpeech;
        log_1.log.info({
            event: 'audio_disconnect_finalize_decision',
            call_control_id: this.callControlId,
            state: this.state,
            saw_speech: this.sawSpeech,
            should_finalize: shouldFinalize,
            ...(this.logContext ?? {}),
        }, 'audio disconnect finalize decision');
        return shouldFinalize;
    }
    isFinalInFlight() {
        return this.finalInFlight;
    }
    resetUtteranceTiming() {
        this.preRollMs = 0;
        this.utteranceTotalMs = 0;
        this.speechMs = 0;
        this.trailingSilenceMs = 0;
        this.sttReqStartAtMs = 0;
        this.sttReqEndAtMs = 0;
        this.ttsStartAtMs = 0;
        this.ttsEndAtMs = 0;
        this.summaryPending = false;
    }
    updateMediaReady(ts, forceLog = false) {
        const next = this.wsConnected &&
            this.firstInboundFrameSeen &&
            this.mediaReadyConsecutiveMs >= MEDIA_READY_MIN_MS;
        if (next === this.mediaReady && !forceLog) {
            return false;
        }
        this.mediaReady = next;
        log_1.log.info({
            event: 'media_ready_change',
            call_control_id: this.callControlId,
            ws_connected: this.wsConnected,
            first_inbound_frame_seen: this.firstInboundFrameSeen,
            media_ready: this.mediaReady,
            ts,
            ...(this.logContext ?? {}),
        }, 'media ready change');
        return true;
    }
    maybeArmListening(reason, ts) {
        if (this.state === 'ENDING')
            return;
        if (!this.isCallActive())
            return;
        if (!this.canArmListening())
            return;
        const playbackActive = this.isPlaybackActive();
        const mediaReady = this.mediaReady;
        if (playbackActive || !mediaReady)
            return;
        if (this.state === 'CAPTURING' || this.state === 'FINALIZING_STT' || this.state === 'RESPONDING') {
            return;
        }
        if (this.isListening()) {
            return;
        }
        this.sttArmedAtMs = ts;
        this.transition('LISTENING', reason, ts);
        this.onArmListening(reason);
        log_1.log.info({
            event: 'stt_listening_armed',
            call_control_id: this.callControlId,
            reason,
            playback_active: playbackActive,
            media_ready: mediaReady,
            ts,
            ...(this.logContext ?? {}),
        }, 'stt listening armed');
    }
    transition(next, reason, ts) {
        if (this.state === next) {
            return;
        }
        const prev = this.state;
        this.state = next;
        log_1.log.info({
            event: 'audio_state_transition',
            from: prev,
            to: next,
            reason,
            call_control_id: this.callControlId,
            ts,
            ...(this.logContext ?? {}),
        }, 'audio state transition');
        if (this.summaryPending && (next === 'LISTENING' || next === 'ENDING')) {
            this.emitTimingSummary(ts);
        }
    }
    emitTimingSummary(ts) {
        if (!this.summaryPending)
            return;
        this.summaryPending = false;
        const summary = {
            event: 'timing_summary',
            call_control_id: this.callControlId,
            playback_ended_at_ms: this.playbackEndedAtMs || null,
            ws_connected_at_ms: this.wsConnectedAtMs || null,
            first_frame_at_ms: this.firstFrameAtMs || null,
            stt_armed_at_ms: this.sttArmedAtMs || null,
            utterance_start_at_ms: this.utteranceStartAtMs || null,
            preroll_ms: Number.isFinite(this.preRollMs) ? this.preRollMs : null,
            utterance_total_ms: Number.isFinite(this.utteranceTotalMs) ? this.utteranceTotalMs : null,
            speech_ms: Number.isFinite(this.speechMs) ? this.speechMs : null,
            trailing_silence_ms: Number.isFinite(this.trailingSilenceMs) ? this.trailingSilenceMs : null,
            hangup_received_at_ms: this.hangupReceivedAtMs || null,
            stt_req_start_at_ms: this.sttReqStartAtMs || null,
            stt_req_end_at_ms: this.sttReqEndAtMs || null,
            tts_start_at_ms: this.ttsStartAtMs || null,
            tts_end_at_ms: this.ttsEndAtMs || null,
            delta_playback_to_first_frame_ms: this.playbackEndedAtMs && this.firstFrameAtMs ? this.firstFrameAtMs - this.playbackEndedAtMs : null,
            delta_first_frame_to_armed_ms: this.firstFrameAtMs && this.sttArmedAtMs ? this.sttArmedAtMs - this.firstFrameAtMs : null,
            delta_armed_to_speech_ms: this.sttArmedAtMs && this.utteranceStartAtMs ? this.utteranceStartAtMs - this.sttArmedAtMs : null,
            summary_ts: ts,
        };
        log_1.log.info(summary, 'timing summary');
        this.utteranceStartAtMs = 0;
        this.sawSpeech = false;
    }
}
exports.CallAudioCoordinator = CallAudioCoordinator;
//# sourceMappingURL=callAudioCoordinator.js.map