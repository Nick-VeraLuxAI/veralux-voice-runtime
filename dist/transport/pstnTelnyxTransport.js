"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PstnTelnyxTransportSession = void 0;
const env_1 = require("../env");
const log_1 = require("../log");
const telnyxClient_1 = require("../telnyx/telnyxClient");
class PstnAudioIngest {
    start() {
        // no-op: Telnyx media WS drives ingest
    }
    stop() {
        // no-op
    }
    onFrame(cb) {
        this.onFrameCb = cb;
    }
    pushFrame(frame) {
        this.onFrameCb?.(frame);
    }
}
class PstnAudioPlayback {
    constructor(options) {
        this.playbackEndCallbacks = [];
        this.telnyx = options.telnyx;
        this.callControlId = options.callControlId;
        this.logContext = options.logContext;
        this.isActive = options.isActive;
        this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
    }
    onPlaybackEnd(cb) {
        this.playbackEndCallbacks.push(cb);
    }
    notifyPlaybackEnded() {
        for (const cb of this.playbackEndCallbacks) {
            try {
                cb();
            }
            catch (error) {
                log_1.log.warn({ err: error, ...this.logContext }, 'playback end callback failed');
            }
        }
    }
    async play(input) {
        if (this.shouldSkipTelnyxAction('playback_start')) {
            return;
        }
        if (input.kind !== 'url') {
            log_1.log.warn({ event: 'playback_buffer_unsupported', ...this.logContext }, 'pstn playback expects url');
            return;
        }
        await this.telnyx.playAudio(this.callControlId, input.url);
    }
    async stop() {
        if (this.shouldSkipTelnyxAction('playback_stop')) {
            return;
        }
        await this.telnyx.stopPlayback(this.callControlId);
    }
    shouldSkipTelnyxAction(action) {
        if (!this.isActive || this.isActive()) {
            return false;
        }
        if (action === 'playback_start' && this.allowPlaybackWhenInactive?.()) {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
class PstnTelnyxTransportSession {
    constructor(options) {
        this.mode = 'pstn';
        this.audioInput = {
            codec: 'pcm16le',
            sampleRateHz: env_1.env.TELNYX_TARGET_SAMPLE_RATE, // import env here
        };
        this.id = options.callControlId;
        this.logContext = {
            call_control_id: options.callControlId,
            tenant_id: options.tenantId,
            requestId: options.requestId,
        };
        this.isActive = options.isActive;
        this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
        this.telnyx = new telnyxClient_1.TelnyxClient(this.logContext);
        this.ingest = new PstnAudioIngest();
        this.playback = new PstnAudioPlayback({
            telnyx: this.telnyx,
            callControlId: options.callControlId,
            logContext: this.logContext,
            isActive: this.isActive,
            allowPlaybackWhenInactive: this.allowPlaybackWhenInactive,
        });
    }
    async start() {
        if (this.shouldSkipTelnyxAction('answer')) {
            return;
        }
        await this.telnyx.answerCall(this.id);
    }
    async stop(reason) {
        if (this.shouldSkipTelnyxAction('hangup')) {
            return;
        }
        try {
            log_1.log.info({
                event: 'telnyx_hangup_requested',
                reason: reason ?? 'unspecified',
                ...this.logContext,
            }, 'telnyx hangup requested (transport.stop)');
            await this.telnyx.hangupCall(this.id);
        }
        catch (error) {
            log_1.log.error({ err: error, reason, ...this.logContext }, 'telnyx hangup failed');
        }
    }
    pushFrame(frame) {
        this.ingest.pushFrame(frame);
    }
    notifyPlaybackEnded() {
        this.playback.notifyPlaybackEnded();
    }
    shouldSkipTelnyxAction(action) {
        if (!this.isActive || this.isActive()) {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
exports.PstnTelnyxTransportSession = PstnTelnyxTransportSession;
//# sourceMappingURL=pstnTelnyxTransport.js.map