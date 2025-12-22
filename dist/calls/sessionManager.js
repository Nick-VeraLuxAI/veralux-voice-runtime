"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const capacity_1 = require("../limits/capacity");
const log_1 = require("../log");
const callSession_1 = require("./callSession");
const DEFAULT_IDLE_TTL_MINUTES = 10;
const DEFAULT_SWEEP_INTERVAL_MS = 60000;
class SessionManager {
    constructor(options = {}) {
        this.sessions = new Map();
        this.queues = new Map();
        this.mediaConnections = new Map();
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
        session.start({ autoAnswer: options.autoAnswer });
        this.sessions.set(config.callControlId, session);
        log_1.log.info({
            event: 'call_session_created',
            call_control_id: session.callControlId,
            tenant_id: session.tenantId,
            from: session.from,
            to: session.to,
            state: session.getState(),
            requestId: context.requestId,
        }, 'call session created');
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
    onHangup(callControlId, reason, context = {}) {
        const session = this.sessions.get(callControlId);
        if (!session) {
            log_1.log.warn({
                event: 'call_session_hangup_missing',
                call_control_id: callControlId,
                reason,
                tenant_id: context.tenantId,
                requestId: context.requestId,
            }, 'call session missing on hangup');
            return;
        }
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
        const session = this.sessions.get(callControlId);
        if (!session) {
            this.closeMediaConnections(callControlId, reason ?? 'teardown');
            this.clearQueue(callControlId);
            if (context.tenantId) {
                void this.capacityRelease({
                    tenantId: context.tenantId,
                    callControlId,
                    requestId: context.requestId,
                });
            }
            return;
        }
        session.end();
        this.sessions.delete(callControlId);
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
        const session = this.sessions.get(callControlId);
        if (!session) {
            log_1.log.warn({
                event: 'call_session_missing_audio',
                call_control_id: callControlId,
            }, 'call session missing for audio');
            return false;
        }
        if (session.getState() === 'ENDED') {
            log_1.log.warn({
                event: 'call_session_audio_ended',
                call_control_id: callControlId,
            }, 'call session ended for audio');
            return false;
        }
        session.onAudioFrame(frame);
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
                await task();
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
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map