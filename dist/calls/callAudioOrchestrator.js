"use strict";
// src/calls/callAudioOrchestrator.ts
// How it works: owns per-call audio readiness + listening transitions (mediaReady + playback),
// keeps a PCM16 pre-roll ring buffer, and emits timing logs for deterministic STT arming.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallAudioOrchestrator = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
const inboundRingBuffer_1 = require("../audio/inboundRingBuffer");
const MEDIA_READY_MIN_MS = 200;
const MEDIA_READY_MAX_GAP_MS = 300;
class CallAudioOrchestrator {
    constructor(options) {
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
        this.callControlId = options.callControlId;
        this.logContext = options.logContext;
        this.isPlaybackActive = options.isPlaybackActive;
        this.isCallActive = options.isCallActive;
        this.canArmListening = options.canArmListening;
        this.isListening = options.isListening;
        this.onArmListening = options.onArmListening;
        const preRollMs = Math.max(1, Math.floor(env_1.env.STT_PRE_ROLL_MS || 1200));
        this.ringBuffer = new inboundRingBuffer_1.InboundPcm16RingBuffer({
            sampleRateHz: options.sampleRateHz,
            maxMs: preRollMs,
        });
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
        if (!this.wsConnected) {
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
    onPlaybackEnded(ts = Date.now()) {
        this.playbackEndedAtMs = ts;
        this.maybeArmListening('playback_ended', ts);
    }
    notifyListeningEligibilityChanged(reason, ts = Date.now()) {
        this.maybeArmListening(reason, ts);
    }
    isMediaReady() {
        return this.mediaReady;
    }
    consumePreRollForUtterance() {
        return this.ringBuffer.snapshot();
    }
    onUtteranceStart(ts = Date.now()) {
        this.utteranceStartAtMs = ts;
    }
    onUtteranceEnd() {
        const summary = {
            event: 'timing_summary',
            call_control_id: this.callControlId,
            playback_ended_at_ms: this.playbackEndedAtMs || null,
            ws_connected_at_ms: this.wsConnectedAtMs || null,
            first_frame_at_ms: this.firstFrameAtMs || null,
            stt_armed_at_ms: this.sttArmedAtMs || null,
            utterance_start_at_ms: this.utteranceStartAtMs || null,
            delta_playback_to_first_frame_ms: this.playbackEndedAtMs && this.firstFrameAtMs ? this.firstFrameAtMs - this.playbackEndedAtMs : null,
            delta_first_frame_to_armed_ms: this.firstFrameAtMs && this.sttArmedAtMs ? this.sttArmedAtMs - this.firstFrameAtMs : null,
            delta_armed_to_speech_ms: this.sttArmedAtMs && this.utteranceStartAtMs ? this.utteranceStartAtMs - this.sttArmedAtMs : null,
        };
        log_1.log.info(summary, 'timing summary');
        this.utteranceStartAtMs = 0;
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
        if (!this.isCallActive())
            return;
        if (!this.canArmListening())
            return;
        const playbackActive = this.isPlaybackActive();
        const mediaReady = this.mediaReady;
        if (playbackActive || !mediaReady)
            return;
        if (this.isListening()) {
            return;
        }
        this.sttArmedAtMs = ts;
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
}
exports.CallAudioOrchestrator = CallAudioOrchestrator;
//# sourceMappingURL=callAudioOrchestrator.js.map