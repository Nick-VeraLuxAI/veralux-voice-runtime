import { release, type ReleaseParams } from '../limits/capacity';
import { log } from '../log';
import { incInboundAudioFrames, incInboundAudioFramesDropped } from '../metrics';
import { CallSession } from './callSession';
import { CallSessionConfig, CallSessionId } from './types';
import type { TransportMode, TransportSession } from '../transport/types';

const DEFAULT_IDLE_TTL_MINUTES = 10;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

interface WorkItem {
  name: string;
  run: () => Promise<void> | void;
  requiresActive?: boolean;
}

interface QueueState {
  items: WorkItem[];
  running: boolean;
}

export interface SessionLogContext {
  requestId?: string;
  tenantId?: string;
}

export interface MediaConnection {
  close: (code?: number, reason?: string) => void;
}

export class SessionManager {
  private readonly sessions = new Map<CallSessionId, CallSession>();
  private readonly idleTtlMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly queues = new Map<CallSessionId, QueueState>();
  private readonly mediaConnections = new Map<CallSessionId, Set<MediaConnection>>();
  private readonly transports = new Map<CallSessionId, TransportSession>();
  private readonly capacityRelease: (params: ReleaseParams) => Promise<void>;
  private readonly inactiveCalls = new Map<CallSessionId, number>();

  constructor(
    options: {
      idleTtlMinutes?: number;
      sweepIntervalMs?: number;
      capacityRelease?: (params: ReleaseParams) => Promise<void>;
    } = {},
  ) {
    const idleMinutes = options.idleTtlMinutes ?? DEFAULT_IDLE_TTL_MINUTES;
    this.idleTtlMs = Math.max(idleMinutes, 1) * 60_000;
    this.capacityRelease = options.capacityRelease ?? release;

    const sweepInterval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweepIdleSessions(), sweepInterval);
    this.sweepTimer.unref?.();
  }

  public enqueue(callControlId: CallSessionId, task: WorkItem): void {
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

  public createSession(
    config: CallSessionConfig,
    context: SessionLogContext = {},
    options: { autoAnswer?: boolean } = {},
  ): CallSession {
    const existing = this.sessions.get(config.callControlId);
    if (existing) {
      log.info(
        {
          event: 'call_session_exists',
          call_control_id: existing.callControlId,
          tenant_id: existing.tenantId,
          requestId: context.requestId,
        },
        'call session exists',
      );
      return existing;
    }

    const session = new CallSession({ ...config, requestId: context.requestId ?? config.requestId });
    this.sessions.set(config.callControlId, session);

    const transport = session.getTransport();
    this.transports.set(config.callControlId, transport);
    transport.ingest.onFrame((frame) => session.onAudioFrame(frame));
    transport.playback.onPlaybackEnd(() => session.onPlaybackEnded());
    void Promise.resolve(transport.ingest.start()).catch((error) => {
      log.warn(
        { err: error, call_control_id: session.callControlId, tenant_id: session.tenantId, requestId: context.requestId },
        'transport ingest start failed',
      );
    });

    session.start({ autoAnswer: options.autoAnswer });

    log.info(
      {
        event: 'call_session_created',
        call_control_id: session.callControlId,
        tenant_id: session.tenantId,
        from: session.from,
        to: session.to,
        state: session.getState(),
        requestId: context.requestId,
      },
      'call session created',
    );

    const transportMode = transport.mode;
    const idKey = transportMode === 'webrtc_hd' ? 'session_id' : 'call_control_id';
    log.info(
      {
        event: 'transport_selected',
        transport_mode: transportMode,
        tenant_id: session.tenantId,
        requestId: context.requestId,
        [idKey]: session.callControlId,
      },
      'transport selected',
    );

    return session;
  }

  public onAnswered(callControlId: CallSessionId, context: SessionLogContext = {}): void {
    const session =
      this.sessions.get(callControlId) ??
      this.createSession({ callControlId }, context, { autoAnswer: false });
    const changed = session.onAnswered();

    log.info(
      {
        event: changed ? 'call_session_answered' : 'call_session_answered_duplicate',
        call_control_id: session.callControlId,
        tenant_id: session.tenantId,
        state: session.getState(),
        requestId: context.requestId,
      },
      'call session answered',
    );
  }

  public onPlaybackEnded(callControlId: CallSessionId, context: SessionLogContext = {}): void {
    const session = this.sessions.get(callControlId);
    if (!session) {
      log.warn(
        {
          event: 'call_session_playback_end_missing',
          call_control_id: callControlId,
          requestId: context.requestId,
        },
        'call session missing on playback end',
      );
      return;
    }

    const transport = this.transports.get(callControlId);
    if (transport?.notifyPlaybackEnded) {
      transport.notifyPlaybackEnded();
    } else {
      session.onPlaybackEnded();
    }

    log.info(
      {
        event: 'call_session_playback_end',
        call_control_id: session.callControlId,
        tenant_id: session.tenantId,
        state: session.getState(),
        requestId: context.requestId,
      },
      'call session playback ended',
    );
  }

  public isCallActive(callControlId: CallSessionId): boolean {
    if (this.inactiveCalls.has(callControlId)) {
      return false;
    }

    const session = this.sessions.get(callControlId);
    return session ? session.isActive() : true;
  }

  public getTransportMode(callControlId: CallSessionId): TransportMode | undefined {
    const transport = this.transports.get(callControlId);
    return transport?.mode;
  }

  public notifyIngestFailure(callControlId: CallSessionId, reason: string): void {
    const session = this.sessions.get(callControlId);
    if (!session) {
      log.warn(
        {
          event: 'call_session_ingest_missing',
          call_control_id: callControlId,
          reason,
        },
        'call session missing for ingest failure',
      );
      return;
    }

    session.notifyIngestFailure(reason);
  }

  public onHangup(callControlId: CallSessionId, reason?: string, context: SessionLogContext = {}): void {
    const session = this.sessions.get(callControlId);
    if (!session) {
      this.inactiveCalls.set(callControlId, Date.now());
      log.warn(
        {
          event: 'call_session_hangup_missing',
          call_control_id: callControlId,
          reason,
          tenant_id: context.tenantId,
          requestId: context.requestId,
        },
        'call session missing on hangup',
      );
      return;
    }

    session.markEnded(reason ?? 'hangup');
    this.inactiveCalls.set(callControlId, Date.now());
    const changed = session.end();

    log.info(
      {
        event: changed ? 'call_session_hangup' : 'call_session_hangup_duplicate',
        call_control_id: session.callControlId,
        tenant_id: session.tenantId,
        reason,
        state: session.getState(),
        requestId: context.requestId,
      },
      'call session hangup',
    );

    this.teardown(callControlId, reason ?? 'hangup', context);
  }

  public teardown(callControlId: CallSessionId, reason?: string, context: SessionLogContext = {}): void {
    const session = this.sessions.get(callControlId);
    if (!session) {
      this.inactiveCalls.set(callControlId, Date.now());
      this.closeMediaConnections(callControlId, reason ?? 'teardown');
      this.clearQueue(callControlId);
      const transport = this.transports.get(callControlId);
      if (transport) {
        this.transports.delete(callControlId);
        void Promise.resolve(transport.stop(reason)).catch((error) => {
          log.warn({ err: error, call_control_id: callControlId }, 'transport stop failed');
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
        log.warn({ err: error, call_control_id: callControlId }, 'transport stop failed');
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
    } else {
      log.warn(
        {
          event: 'capacity_release_skipped',
          call_control_id: session.callControlId,
          requestId: context.requestId,
        },
        'capacity release skipped missing tenant',
      );
    }

    const metrics = session.getMetrics();
    const durationMs = Date.now() - metrics.createdAt.getTime();

    log.info(
      {
        event: 'call_session_teardown',
        call_control_id: session.callControlId,
        tenant_id: session.tenantId,
        reason,
        state: session.getState(),
        turns: metrics.turns,
        session_duration_ms: durationMs,
        last_heard_at: metrics.lastHeardAt?.toISOString(),
        requestId: context.requestId,
      },
      'call session teardown',
    );
  }

  public pushAudio(callControlId: CallSessionId, frame: Buffer): boolean {
    incInboundAudioFrames();
    const session = this.sessions.get(callControlId);
    if (!session) {
      incInboundAudioFramesDropped('missing_session');
      log.warn(
        {
          event: 'call_session_missing_audio',
          call_control_id: callControlId,
        },
        'call session missing for audio',
      );
      return false;
    }

    if (!session.isActive() || session.getState() === 'ENDED') {
      incInboundAudioFramesDropped('inactive_session');
      log.warn(
        {
          event: 'call_session_audio_ended',
          call_control_id: callControlId,
        },
        'call session ended for audio',
      );
      return false;
    }

    const transport = this.transports.get(callControlId);
    if (transport?.pushFrame) {
      transport.pushFrame(frame);
    } else {
      session.onAudioFrame(frame);
    }
    return true;
  }

  public pushPcm16(callControlId: CallSessionId, pcm16: Int16Array, sampleRateHz: number): boolean {
    if (sampleRateHz <= 0) {
      log.warn(
        {
          event: 'call_session_pcm16_invalid_rate',
          call_control_id: callControlId,
          sample_rate_hz: sampleRateHz,
        },
        'invalid pcm16 sample rate',
      );
    }
    const buffer = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    return this.pushAudio(callControlId, buffer);
  }

  public registerMediaConnection(callControlId: CallSessionId, connection: MediaConnection): void {
    const connections = this.mediaConnections.get(callControlId) ?? new Set<MediaConnection>();
    connections.add(connection);
    this.mediaConnections.set(callControlId, connections);
  }

  public unregisterMediaConnection(callControlId: CallSessionId, connection: MediaConnection): void {
    const connections = this.mediaConnections.get(callControlId);
    if (!connections) {
      return;
    }

    connections.delete(connection);
    if (connections.size === 0) {
      this.mediaConnections.delete(callControlId);
    }
  }

  private async runQueue(callControlId: CallSessionId, queue: QueueState): Promise<void> {
    while (queue.items.length > 0) {
      const task = queue.items.shift();
      if (!task) {
        continue;
      }

      try {
        const session = this.sessions.get(callControlId);
        const requiresActive = task.requiresActive !== false;
        if (requiresActive) {
          const inactive =
            this.inactiveCalls.has(callControlId) || (session ? !session.isActive() : false);
          if (inactive) {
            log.warn(
              {
                event: 'call_session_task_skipped_inactive',
                task: task.name,
                call_control_id: callControlId,
                tenant_id: session?.tenantId,
              },
              'skipping queued task - call inactive',
            );
            continue;
          }
        }

        await task.run();
      } catch (error) {
        log.error(
          { err: error, call_control_id: callControlId, event: 'call_session_task_failed' },
          'session task failed',
        );
      }
    }

    queue.running = false;
    if (queue.items.length === 0) {
      this.queues.delete(callControlId);
    }
  }

  private clearQueue(callControlId: CallSessionId): void {
    const queue = this.queues.get(callControlId);
    if (!queue) {
      return;
    }

    queue.items.length = 0;
    if (!queue.running) {
      this.queues.delete(callControlId);
    }
  }

  private closeMediaConnections(callControlId: CallSessionId, reason: string): void {
    const connections = this.mediaConnections.get(callControlId);
    if (!connections) {
      return;
    }

    for (const connection of connections) {
      try {
        connection.close(1000, reason);
      } catch (error) {
        log.warn(
          { err: error, call_control_id: callControlId, event: 'media_connection_close_failed' },
          'media connection close failed',
        );
      }
    }

    this.mediaConnections.delete(callControlId);
  }

  private sweepIdleSessions(): void {
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
