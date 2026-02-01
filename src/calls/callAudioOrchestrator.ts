// src/calls/callAudioOrchestrator.ts
// How it works: owns per-call audio readiness + listening transitions (mediaReady + playback),
// keeps a PCM16 pre-roll ring buffer, and emits timing logs for deterministic STT arming.

import { env } from '../env';
import { log } from '../log';
import { InboundPcm16RingBuffer, type Pcm16RingSnapshot } from '../audio/inboundRingBuffer';
import type { Pcm16Frame } from '../media/types';

const MEDIA_READY_MIN_MS = 200;
const MEDIA_READY_MAX_GAP_MS = 300;

type OrchestratorOptions = {
  callControlId: string;
  sampleRateHz: number;
  logContext?: Record<string, unknown>;
  isPlaybackActive: () => boolean;
  isCallActive: () => boolean;
  canArmListening: () => boolean;
  isListening: () => boolean;
  onArmListening: (reason: string) => void;
};

export class CallAudioOrchestrator {
  private readonly callControlId: string;
  private readonly logContext?: Record<string, unknown>;
  private readonly isPlaybackActive: () => boolean;
  private readonly isCallActive: () => boolean;
  private readonly canArmListening: () => boolean;
  private readonly isListening: () => boolean;
  private readonly onArmListening: (reason: string) => void;
  private readonly ringBuffer: InboundPcm16RingBuffer;

  private wsConnected = false;
  private firstInboundFrameSeen = false;
  private mediaReady = false;
  private mediaReadyConsecutiveMs = 0;
  private lastInboundFrameAtMs = 0;

  private wsConnectedAtMs = 0;
  private firstFrameAtMs = 0;
  private playbackEndedAtMs = 0;
  private sttArmedAtMs = 0;
  private utteranceStartAtMs = 0;

  constructor(options: OrchestratorOptions) {
    this.callControlId = options.callControlId;
    this.logContext = options.logContext;
    this.isPlaybackActive = options.isPlaybackActive;
    this.isCallActive = options.isCallActive;
    this.canArmListening = options.canArmListening;
    this.isListening = options.isListening;
    this.onArmListening = options.onArmListening;

    const preRollMs = Math.max(1, Math.floor(env.STT_PRE_ROLL_MS || 1200));
    this.ringBuffer = new InboundPcm16RingBuffer({
      sampleRateHz: options.sampleRateHz,
      maxMs: preRollMs,
    });
  }

  public setWsConnected(connected: boolean, ts: number = Date.now()): void {
    this.wsConnected = connected;
    if (connected) {
      this.wsConnectedAtMs = ts;
    } else {
      this.firstInboundFrameSeen = false;
      this.mediaReadyConsecutiveMs = 0;
      this.lastInboundFrameAtMs = 0;
      this.ringBuffer.reset();
    }
    this.updateMediaReady(ts, true);
    this.maybeArmListening(connected ? 'ws_connected' : 'ws_disconnected', ts);
  }

  public onInboundFrame(frame: Pcm16Frame, ts: number = Date.now()): void {
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

  public onPlaybackEnded(ts: number = Date.now()): void {
    this.playbackEndedAtMs = ts;
    this.maybeArmListening('playback_ended', ts);
  }

  public notifyListeningEligibilityChanged(reason: string, ts: number = Date.now()): void {
    this.maybeArmListening(reason, ts);
  }

  public isMediaReady(): boolean {
    return this.mediaReady;
  }

  public consumePreRollForUtterance(): Pcm16RingSnapshot | null {
    return this.ringBuffer.snapshot();
  }

  public onUtteranceStart(ts: number = Date.now()): void {
    this.utteranceStartAtMs = ts;
  }

  public onUtteranceEnd(): void {
    const summary = {
      event: 'timing_summary',
      call_control_id: this.callControlId,
      playback_ended_at_ms: this.playbackEndedAtMs || null,
      ws_connected_at_ms: this.wsConnectedAtMs || null,
      first_frame_at_ms: this.firstFrameAtMs || null,
      stt_armed_at_ms: this.sttArmedAtMs || null,
      utterance_start_at_ms: this.utteranceStartAtMs || null,
      delta_playback_to_first_frame_ms:
        this.playbackEndedAtMs && this.firstFrameAtMs ? this.firstFrameAtMs - this.playbackEndedAtMs : null,
      delta_first_frame_to_armed_ms:
        this.firstFrameAtMs && this.sttArmedAtMs ? this.sttArmedAtMs - this.firstFrameAtMs : null,
      delta_armed_to_speech_ms:
        this.sttArmedAtMs && this.utteranceStartAtMs ? this.utteranceStartAtMs - this.sttArmedAtMs : null,
    };

    log.info(summary, 'timing summary');

    this.utteranceStartAtMs = 0;
  }

  private updateMediaReady(ts: number, forceLog: boolean = false): boolean {
    const next =
      this.wsConnected &&
      this.firstInboundFrameSeen &&
      this.mediaReadyConsecutiveMs >= MEDIA_READY_MIN_MS;
    if (next === this.mediaReady && !forceLog) {
      return false;
    }
    this.mediaReady = next;
    log.info(
      {
        event: 'media_ready_change',
        call_control_id: this.callControlId,
        ws_connected: this.wsConnected,
        first_inbound_frame_seen: this.firstInboundFrameSeen,
        media_ready: this.mediaReady,
        ts,
        ...(this.logContext ?? {}),
      },
      'media ready change',
    );
    return true;
  }

  private maybeArmListening(reason: string, ts: number): void {
    if (!this.isCallActive()) return;
    if (!this.canArmListening()) return;

    const playbackActive = this.isPlaybackActive();
    const mediaReady = this.mediaReady;
    if (playbackActive || !mediaReady) return;

    if (this.isListening()) {
      return;
    }

    this.sttArmedAtMs = ts;
    this.onArmListening(reason);

    log.info(
      {
        event: 'stt_listening_armed',
        call_control_id: this.callControlId,
        reason,
        playback_active: playbackActive,
        media_ready: mediaReady,
        ts,
        ...(this.logContext ?? {}),
      },
      'stt listening armed',
    );
  }
}
