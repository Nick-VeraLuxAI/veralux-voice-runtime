import { env } from '../env';
import { log } from '../log';
import { TelnyxClient } from '../telnyx/telnyxClient';
import type { AudioIngest, AudioPlayback, PlaybackInput, TransportSession } from './types';

class PstnAudioIngest implements AudioIngest {
  private onFrameCb?: (frame: Buffer) => void;

  start(): void {
    // no-op: Telnyx media WS drives ingest
  }

  stop(): void {
    // no-op
  }

  onFrame(cb: (frame: Buffer) => void): void {
    this.onFrameCb = cb;
  }

  pushFrame(frame: Buffer): void {
    this.onFrameCb?.(frame);
  }
}

class PstnAudioPlayback implements AudioPlayback {
  private readonly telnyx: TelnyxClient;
  private readonly callControlId: string;
  private readonly logContext: Record<string, unknown>;
  private readonly isActive?: () => boolean;
  /** When true, allow playback_start even if call is inactive (e.g. late-final response). */
  private readonly allowPlaybackWhenInactive?: () => boolean;
  private readonly playbackEndCallbacks: Array<() => void> = [];

  constructor(options: {
    telnyx: TelnyxClient;
    callControlId: string;
    logContext: Record<string, unknown>;
    isActive?: () => boolean;
    allowPlaybackWhenInactive?: () => boolean;
  }) {
    this.telnyx = options.telnyx;
    this.callControlId = options.callControlId;
    this.logContext = options.logContext;
    this.isActive = options.isActive;
    this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
  }

  onPlaybackEnd(cb: () => void): void {
    this.playbackEndCallbacks.push(cb);
  }

  notifyPlaybackEnded(): void {
    for (const cb of this.playbackEndCallbacks) {
      try {
        cb();
      } catch (error) {
        log.warn({ err: error, ...this.logContext }, 'playback end callback failed');
      }
    }
  }

  async play(input: PlaybackInput): Promise<void> {
    if (this.shouldSkipTelnyxAction('playback_start')) {
      return;
    }
    if (input.kind !== 'url') {
      log.warn({ event: 'playback_buffer_unsupported', ...this.logContext }, 'pstn playback expects url');
      return;
    }
    await this.telnyx.playAudio(this.callControlId, input.url);
  }

  async stop(): Promise<void> {
    if (this.shouldSkipTelnyxAction('playback_stop')) {
      return;
    }
    await this.telnyx.stopPlayback(this.callControlId);
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (!this.isActive || this.isActive()) {
      return false;
    }
    if (action === 'playback_start' && this.allowPlaybackWhenInactive?.()) {
      return false;
    }

    const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
    log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
    return true;
  }
}

export class PstnTelnyxTransportSession implements TransportSession {
  public readonly id: string;
  public readonly mode = 'pstn' as const;
  public readonly ingest: PstnAudioIngest;
  public readonly playback: PstnAudioPlayback;
  public readonly audioInput = {
    codec: 'pcm16le' as const,
    sampleRateHz: env.TELNYX_TARGET_SAMPLE_RATE, // import env here
  };

  private readonly telnyx: TelnyxClient;
  private readonly logContext: Record<string, unknown>;
  private readonly isActive?: () => boolean;
  private readonly allowPlaybackWhenInactive?: () => boolean;

  constructor(options: {
    callControlId: string;
    tenantId?: string;
    requestId?: string;
    isActive?: () => boolean;
    allowPlaybackWhenInactive?: () => boolean;
  }) {
    this.id = options.callControlId;
    this.logContext = {
      call_control_id: options.callControlId,
      tenant_id: options.tenantId,
      requestId: options.requestId,
    };
    this.isActive = options.isActive;
    this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
    this.telnyx = new TelnyxClient(this.logContext);
    this.ingest = new PstnAudioIngest();
    this.playback = new PstnAudioPlayback({
      telnyx: this.telnyx,
      callControlId: options.callControlId,
      logContext: this.logContext,
      isActive: this.isActive,
      allowPlaybackWhenInactive: this.allowPlaybackWhenInactive,
    });
  }

  async start(): Promise<void> {
    if (this.shouldSkipTelnyxAction('answer')) {
      return;
    }
    await this.telnyx.answerCall(this.id);
  }

  async stop(reason?: string): Promise<void> {
    if (this.shouldSkipTelnyxAction('hangup')) {
      return;
    }
    try {
      log.info(
        {
          event: 'telnyx_hangup_requested',
          reason: reason ?? 'unspecified',
          ...this.logContext,
        },
        'telnyx hangup requested (transport.stop)',
      );
      await this.telnyx.hangupCall(this.id);
    } catch (error) {
      log.error({ err: error, reason, ...this.logContext }, 'telnyx hangup failed');
    }
  }

  pushFrame(frame: Buffer): void {
    this.ingest.pushFrame(frame);
  }

  notifyPlaybackEnded(): void {
    this.playback.notifyPlaybackEnded();
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (!this.isActive || this.isActive()) {
      return false;
    }

    const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
    log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
    return true;
  }
}
