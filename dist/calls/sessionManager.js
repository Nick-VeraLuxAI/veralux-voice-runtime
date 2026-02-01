"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
// src/calls/sessionManager.ts
const capacity_1 = require("../limits/capacity");
const log_1 = require("../log");
const metrics_1 = require("../metrics");
const callSession_1 = require("./callSession");
const codecDecode_1 = require("../audio/codecDecode");
const farEndReference_1 = require("../audio/farEndReference");
const aecProcessor_1 = require("../audio/aecProcessor");
const DEFAULT_IDLE_TTL_MINUTES = 10;
const DEFAULT_SWEEP_INTERVAL_MS = 60000;
class SessionManager {
    constructor(options = {}) {
        this.sessions = new Map();
        this.queues = new Map();
        this.mediaConnections = new Map();
        this.transports = new Map();
        this.inactiveCalls = new Map();
        this.pendingMediaWsConnectedAt = new Map();
        const idleMinutes = options.idleTtlMinutes ?? DEFAULT_IDLE_TTL_MINUTES;
        this.idleTtlMs = Math.max(idleMinutes, 1) * 60000;
        this.capacityRelease = options.capacityRelease ?? capacity_1.release;
        const sweepInterval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        this.sweepTimer = setInterval(() => this.sweepIdleSessions(), sweepInterval);
        this.sweepTimer.unref?.();
    }
    enqueue(callControlId, task) {
        const queue = this.queues.get(callControlId) ?? { items: [], running: false };
        queue.items.push(task);
        this.queues.set(callControlId, queue);
        if (!queue.running) {
            queue.running = true;
            setImmediate(() => {
                void this.runQueue(callControlId, queue);
            });
        }
    }
    createSession(config, context = {}, options = {}) {
        const existing = this.sessions.get(config.callControlId);
        if (existing) {
            log_1.log.info({
                event: 'call_session_exists',
                call_control_id: existing.callControlId,
                tenant_id: existing.tenantId,
                requestId: context.requestId,
            }, 'call session exists');
            return existing;
        }
        const session = new callSession_1.CallSession({
            ...config,
            requestId: context.requestId ?? config.requestId,
        });
        this.sessions.set(config.callControlId, session);
        if (this.pendingMediaWsConnectedAt.has(config.callControlId)) {
            session.onMediaWsConnected();
            this.pendingMediaWsConnectedAt.delete(config.callControlId);
        }
        // ===== Anchor: transport wiring =====
        const transport = session.getTransport();
        this.transports.set(config.callControlId, transport);
        // Inbound media frames
        transport.ingest.onFrame((frame) => session.onAudioFrame(frame));
        // 🔒 PLAYBACK_END_WIRING (authoritative: pstn=webhook, webrtc=transport)
        // ✅ Playback end wiring:
        // - WebRTC: transport can reliably emit "playback ended"
        // - PSTN: DO NOT wire this; only Telnyx webhook (call.playback.ended) is authoritative
        if (transport.mode !== 'pstn') {
            transport.playback.onPlaybackEnd(() => {
                session.onPlaybackEnded();
            });
        }
        void Promise.resolve(transport.ingest.start()).catch((error) => {
            log_1.log.warn({
                err: error,
                call_control_id: session.callControlId,
                tenant_id: session.tenantId,
                requestId: context.requestId,
            }, 'transport ingest start failed');
        });
        session.start({ autoAnswer: options.autoAnswer });
        log_1.log.info({
            event: 'call_session_created',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            from: session.from,
            to: session.to,
            state: session.getState(),
            requestId: context.requestId,
        }, 'call session created');
        const transportMode = transport.mode;
        const idKey = transportMode === 'webrtc_hd' ? 'session_id' : 'call_control_id';
        log_1.log.info({
            event: 'transport_selected',
            transport_mode: transportMode,
            tenant_id: session.tenantId,
            requestId: context.requestId,
            [idKey]: session.callControlId,
        }, 'transport selected');
        return session;
    }
    onAnswered(callControlId, context = {}) {
        const session = this.sessions.get(callControlId) ??
            this.createSession({ callControlId }, context, { autoAnswer: false });
        const changed = session.onAnswered();
        log_1.log.info({
            event: changed ? 'call_session_answered' : 'call_session_answered_duplicate',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            state: session.getState(),
            requestId: context.requestId,
        }, 'call session answered');
    }
    onTelnyxPlaybackEnded(callControlId, meta) {
        const session = this.sessions.get(callControlId);
        if (!session)
            return;
        // ✅ This is the only correct entrypoint for Telnyx webhook playback-ended
        session.onTelnyxPlaybackEnded(meta);
    }
    onPlaybackEnded(callControlId, context = {}) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            log_1.log.warn({
                event: 'call_session_playback_end_missing',
                call_control_id: callControlId,
                requestId: context.requestId,
            }, 'call session missing on playback end');
            return;
        }
        const transport = this.transports.get(callControlId);
        // ✅ Guard: this handler is intended for Telnyx PSTN webhook playback end.
        // If we ever get here for WebRTC, ignore to prevent double/incorrect cleanup.
        // If transport is missing, we still accept it (PSTN webhook is authoritative).
        if (transport?.mode === 'webrtc_hd') {
            log_1.log.warn({
                event: 'call_session_playback_end_ignored_non_pstn',
                call_control_id: callControlId,
                tenant_id: session.tenantId,
                requestId: context.requestId,
                mode: transport.mode,
            }, 'ignoring webhook playback end for non-pstn transport');
            return;
        }
        // ✅ Webhook-driven PSTN playback end: CallSession owns cleanup + LISTENING transition.
        session.onTelnyxPlaybackEnded({
            requestId: context.requestId,
            source: 'telnyx_webhook',
        });
        log_1.log.info({
            event: 'call_session_playback_end',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            state: session.getState(),
            requestId: context.requestId,
            mode: transport?.mode ?? 'unknown',
            path: 'direct_session_telnyx',
        }, 'call session playback ended');
    }
    isCallActive(callControlId) {
        if (this.inactiveCalls.has(callControlId)) {
            return false;
        }
        const session = this.sessions.get(callControlId);
        return session ? session.isActive() : true;
    }
    isPlaybackActive(callControlId) {
        const session = this.sessions.get(callControlId);
        return session ? session.isPlaybackActive() : false;
    }
    isListening(callControlId) {
        const session = this.sessions.get(callControlId);
        return session ? session.isListening() : false;
    }
    getLastSpeechStartAtMs(callControlId) {
        const session = this.sessions.get(callControlId);
        return session ? session.getLastSpeechStartAtMs() : 0;
    }
    getTransportMode(callControlId) {
        const transport = this.transports.get(callControlId);
        return transport?.mode;
    }
    notifyIngestFailure(callControlId, reason) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            log_1.log.warn({
                event: 'call_session_ingest_missing',
                call_control_id: callControlId,
                reason,
            }, 'call session missing for ingest failure');
            return;
        }
        session.notifyIngestFailure(reason);
    }
    onHangup(callControlId, reason, context = {}) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            this.inactiveCalls.set(callControlId, Date.now());
            log_1.log.warn({
                event: 'call_session_hangup_missing',
                call_control_id: callControlId,
                reason,
                tenant_id: context.tenantId,
                requestId: context.requestId,
            }, 'call session missing on hangup');
            return;
        }
        session.markEnded(reason ?? 'hangup');
        this.inactiveCalls.set(callControlId, Date.now());
        const changed = session.end();
        log_1.log.info({
            event: changed ? 'call_session_hangup' : 'call_session_hangup_duplicate',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            reason,
            state: session.getState(),
            requestId: context.requestId,
        }, 'call session hangup');
        // If STT is in flight, defer teardown until transcript is captured or grace period expires.
        // That way the final transcript is available before we log teardown and release capacity.
        if (session.getSttInFlightCount() > 0) {
            session.armDeferredTeardown(() => {
                this.teardown(callControlId, reason ?? 'hangup', context);
            });
        }
        else {
            this.teardown(callControlId, reason ?? 'hangup', context);
        }
    }
    teardown(callControlId, reason, context = {}) {
        // ✅ Always clear codec session cache on teardown (session exists OR missing)
        (0, codecDecode_1.clearTelnyxCodecSession)({ call_control_id: callControlId });
        (0, farEndReference_1.releaseFarEndBuffer)(callControlId);
        (0, aecProcessor_1.releaseAecProcessor)(callControlId);
        this.pendingMediaWsConnectedAt.delete(callControlId);
        const session = this.sessions.get(callControlId);
        if (!session) {
            this.inactiveCalls.set(callControlId, Date.now());
            this.closeMediaConnections(callControlId, reason ?? 'teardown');
            this.clearQueue(callControlId);
            const transport = this.transports.get(callControlId);
            if (transport) {
                this.transports.delete(callControlId);
                void Promise.resolve(transport.stop(reason)).catch((error) => {
                    log_1.log.warn({ err: error, call_control_id: callControlId }, 'transport stop failed');
                });
            }
            if (context.tenantId) {
                void this.capacityRelease({
                    tenantId: context.tenantId,
                    callControlId,
                    requestId: context.requestId,
                });
            }
            return;
        }
        session.markEnded(reason ?? 'teardown');
        this.inactiveCalls.set(callControlId, Date.now());
        session.end();
        this.sessions.delete(callControlId);
        const transport = this.transports.get(callControlId);
        if (transport) {
            this.transports.delete(callControlId);
            void Promise.resolve(transport.stop(reason)).catch((error) => {
                log_1.log.warn({ err: error, call_control_id: callControlId }, 'transport stop failed');
            });
        }
        this.closeMediaConnections(callControlId, reason ?? 'teardown');
        this.clearQueue(callControlId);
        if (session.tenantId) {
            void this.capacityRelease({
                tenantId: session.tenantId,
                callControlId: session.callControlId,
                requestId: context.requestId,
            });
        }
        else {
            log_1.log.warn({
                event: 'capacity_release_skipped',
                call_control_id: session.callControlId,
                requestId: context.requestId,
            }, 'capacity release skipped missing tenant');
        }
        const metrics = session.getMetrics();
        const durationMs = Date.now() - metrics.createdAt.getTime();
        // Tier 5: per-call metrics for production hardening
        const emptyPct = metrics.transcriptsTotal > 0
            ? Math.round((100 * metrics.transcriptsEmpty) / metrics.transcriptsTotal)
            : 0;
        const avgCharsPerSec = metrics.totalUtteranceMs > 0
            ? (metrics.totalTranscribedChars / metrics.totalUtteranceMs) * 1000
            : 0;
        (0, metrics_1.recordCallMetrics)({
            tenantId: session.tenantId,
            reason: reason ?? 'teardown',
            durationMs,
            turns: metrics.turns,
            transcriptsTotal: metrics.transcriptsTotal,
            transcriptsEmpty: metrics.transcriptsEmpty,
        });
        log_1.log.info({
            event: 'call_session_teardown',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            reason,
            state: session.getState(),
            turns: metrics.turns,
            session_duration_ms: durationMs,
            last_heard_at: metrics.lastHeardAt?.toISOString(),
            transcripts_total: metrics.transcriptsTotal,
            transcripts_empty: metrics.transcriptsEmpty,
            empty_transcript_pct: emptyPct,
            total_utterance_ms: metrics.totalUtteranceMs,
            total_transcribed_chars: metrics.totalTranscribedChars,
            avg_chars_per_sec: Math.round(avgCharsPerSec * 10) / 10,
            requestId: context.requestId,
        }, 'call session teardown');
    }
    pushAudio(callControlId, frame) {
        (0, metrics_1.incInboundAudioFrames)();
        const session = this.sessions.get(callControlId);
        if (!session) {
            (0, metrics_1.incInboundAudioFramesDropped)('missing_session');
            log_1.log.warn({
                event: 'call_session_missing_audio',
                call_control_id: callControlId,
            }, 'call session missing for audio');
            return false;
        }
        if (!session.isActive() || session.getState() === 'ENDED') {
            (0, metrics_1.incInboundAudioFramesDropped)('inactive_session');
            log_1.log.warn({
                event: 'call_session_audio_ended',
                call_control_id: callControlId,
            }, 'call session ended for audio');
            return false;
        }
        const transport = this.transports.get(callControlId);
        if (transport?.pushFrame) {
            transport.pushFrame(frame);
        }
        else {
            session.onAudioFrame(frame);
        }
        return true;
    }
    pushPcm16(callControlId, pcm16, sampleRateHz) {
        return this.pushPcm16Frame(callControlId, { pcm16, sampleRateHz, channels: 1 });
    }
    pushPcm16Frame(callControlId, frame) {
        (0, metrics_1.incInboundAudioFrames)();
        const session = this.sessions.get(callControlId);
        if (!session) {
            (0, metrics_1.incInboundAudioFramesDropped)('missing_session');
            log_1.log.warn({ event: 'call_session_missing_pcm16', call_control_id: callControlId }, 'missing session for pcm16');
            return false;
        }
        if (!session.isActive() || session.getState() === 'ENDED') {
            (0, metrics_1.incInboundAudioFramesDropped)('inactive_session');
            log_1.log.warn({ event: 'call_session_pcm16_ended', call_control_id: callControlId }, 'session ended for pcm16');
            return false;
        }
        if (frame.sampleRateHz <= 0) {
            log_1.log.warn({
                event: 'call_session_pcm16_invalid_rate',
                call_control_id: callControlId,
                sample_rate_hz: frame.sampleRateHz,
            }, 'invalid pcm16 rate');
        }
        session.onPcm16Frame(frame);
        return true;
    }
    registerMediaConnection(callControlId, connection) {
        const connections = this.mediaConnections.get(callControlId) ?? new Set();
        connections.add(connection);
        this.mediaConnections.set(callControlId, connections);
    }
    unregisterMediaConnection(callControlId, connection) {
        const connections = this.mediaConnections.get(callControlId);
        if (!connections) {
            return;
        }
        connections.delete(connection);
        if (connections.size === 0) {
            this.mediaConnections.delete(callControlId);
        }
    }
    onMediaWsConnected(callControlId) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            this.pendingMediaWsConnectedAt.set(callControlId, Date.now());
            log_1.log.warn({ event: 'call_session_media_ws_missing', call_control_id: callControlId }, 'media ws connected for missing session');
            return;
        }
        this.pendingMediaWsConnectedAt.delete(callControlId);
        session.onMediaWsConnected();
    }
    onMediaWsDisconnected(callControlId) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            this.pendingMediaWsConnectedAt.delete(callControlId);
            return;
        }
        session.onMediaWsDisconnected();
    }
    onMediaStreamingStopped(callControlId, context = {}) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            log_1.log.warn({
                event: 'call_session_streaming_stopped_missing',
                call_control_id: callControlId,
                requestId: context.requestId,
            }, 'call session missing on streaming stopped');
            return;
        }
        session.onMediaStreamingStopped();
    }
    async runQueue(callControlId, queue) {
        while (queue.items.length > 0) {
            const task = queue.items.shift();
            if (!task) {
                continue;
            }
            try {
                const session = this.sessions.get(callControlId);
                const requiresActive = task.requiresActive !== false;
                if (requiresActive) {
                    const inactive = this.inactiveCalls.has(callControlId) || (session ? !session.isActive() : false);
                    if (inactive) {
                        log_1.log.warn({
                            event: 'call_session_task_skipped_inactive',
                            task: task.name,
                            call_control_id: callControlId,
                            tenant_id: session?.tenantId,
                        }, 'skipping queued task - call inactive');
                        continue;
                    }
                }
                await task.run();
            }
            catch (error) {
                log_1.log.error({ err: error, call_control_id: callControlId, event: 'call_session_task_failed' }, 'session task failed');
            }
        }
        queue.running = false;
        if (queue.items.length === 0) {
            this.queues.delete(callControlId);
        }
    }
    clearQueue(callControlId) {
        const queue = this.queues.get(callControlId);
        if (!queue) {
            return;
        }
        queue.items.length = 0;
        if (!queue.running) {
            this.queues.delete(callControlId);
        }
    }
    closeMediaConnections(callControlId, reason) {
        const connections = this.mediaConnections.get(callControlId);
        if (!connections) {
            return;
        }
        for (const connection of connections) {
            try {
                connection.close(1000, reason);
            }
            catch (error) {
                log_1.log.warn({ err: error, call_control_id: callControlId, event: 'media_connection_close_failed' }, 'media connection close failed');
            }
        }
        this.mediaConnections.delete(callControlId);
    }
    sweepIdleSessions() {
        const nowMs = Date.now();
        for (const [callControlId, session] of this.sessions.entries()) {
            const idleMs = nowMs - session.getLastActivityAt().getTime();
            if (idleMs <= this.idleTtlMs) {
                continue;
            }
            this.teardown(callControlId, 'idle_timeout');
        }
        for (const [callControlId, endedAt] of this.inactiveCalls.entries()) {
            if (this.sessions.has(callControlId) || this.queues.has(callControlId)) {
                continue;
            }
            if (nowMs - endedAt > this.idleTtlMs) {
                this.inactiveCalls.delete(callControlId);
            }
        }
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map