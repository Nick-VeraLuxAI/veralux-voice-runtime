"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
// src/calls/sessionManager.ts
const capacity_1 = require("../limits/capacity");
const log_1 = require("../log");
const metrics_1 = require("../metrics");
const callSession_1 = require("./callSession");
const codecDecode_1 = require("../audio/codecDecode");
const DEFAULT_IDLE_TTL_MINUTES = 10;
const DEFAULT_SWEEP_INTERVAL_MS = 60000;
class SessionManager {
    constructor(options = {}) {
        this.sessions = new Map();
        this.queues = new Map();
        this.mediaConnections = new Map();
        this.transports = new Map();
        this.inactiveCalls = new Map();
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
        const session = new callSession_1.CallSession({ ...config, requestId: context.requestId ?? config.requestId });
        this.sessions.set(config.callControlId, session);
        const transport = session.getTransport();
        this.transports.set(config.callControlId, transport);
        transport.ingest.onFrame((frame) => session.onAudioFrame(frame));
        transport.playback.onPlaybackEnd(() => session.onPlaybackEnded());
        void Promise.resolve(transport.ingest.start()).catch((error) => {
            log_1.log.warn({ err: error, call_control_id: session.callControlId, tenant_id: session.tenantId, requestId: context.requestId }, 'transport ingest start failed');
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
        if (transport?.notifyPlaybackEnded) {
            transport.notifyPlaybackEnded();
        }
        else {
            session.onPlaybackEnded();
        }
        log_1.log.info({
            event: 'call_session_playback_end',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            state: session.getState(),
            requestId: context.requestId,
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
        this.teardown(callControlId, reason ?? 'hangup', context);
    }
    teardown(callControlId, reason, context = {}) {
        // ✅ Always clear codec session cache on teardown (session exists OR missing)
        (0, codecDecode_1.clearTelnyxCodecSession)({ call_control_id: callControlId });
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
        log_1.log.info({
            event: 'call_session_teardown',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            reason,
            state: session.getState(),
            turns: metrics.turns,
            session_duration_ms: durationMs,
            last_heard_at: metrics.lastHeardAt?.toISOString(),
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