// src/calls/callAudioCoordinator.ts
// How it works: owns per-call audio state + readiness gating, manages pre-roll buffering,
// and emits timing summaries once each utterance completes.

import { env } from '../env';
import { log } from '../log';
import { InboundPcm16RingBuffer, type Pcm16RingSnapshot } from '../audio/inboundRingBuffer';
import type { Pcm16Frame } from '../media/types';
import type { UtteranceEndInfo } from '../stt/chunkedSTT';

const MEDIA_READY_MIN_MS = 200;
const MEDIA_READY_MAX_GAP_MS = 300;
const PREROLL_DEFAULT_MS = 700;
const PREROLL_MIN_MS = 500;
const PREROLL_MAX_MS = 800;

type AudioState =
  | 'IDLE'
  | 'LISTENING'
  | 'CAPTURING'
  | 'FINALIZING_STT'
  | 'RESPONDING'
  | 'PLAYING'
  | 'ENDING';

type CoordinatorOptions = {
  callControlId: string;
  sampleRateHz: number;
  logContext?: Record<string, unknown>;
  isPlaybackActive: () => boolean;
  isCallActive: () => boolean;
  canArmListening: () => boolean;
  isListening: () => boolean;
  onArmListening: (reason: string) => void;
};

export class CallAudioCoordinator {
  private readonly callControlId: string;
  private readonly logContext?: Record<string, unknown>;
  private readonly isPlaybackActive: () => boolean;
  private readonly isCallActive: () => boolean;
  private readonly canArmListening: () => boolean;
  private readonly isListening: () => boolean;
  private readonly onArmListening: (reason: string) => void;
  private readonly ringBuffer: InboundPcm16RingBuffer;

  private state: AudioState = 'IDLE';

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

  private preRollMs = 0;
  private utteranceTotalMs = 0;
  private speechMs = 0;
  private trailingSilenceMs = 0;
  private hangupReceivedAtMs = 0;
  private sttReqStartAtMs = 0;
  private sttReqEndAtMs = 0;
  private ttsStartAtMs = 0;
  private ttsEndAtMs = 0;

  private sawSpeech = false;
  private finalInFlight = false;
  private summaryPending = false;

  constructor(options: CoordinatorOptions) {
    this.callControlId = options.callControlId;
    this.logContext = options.logContext;
    this.isPlaybackActive = options.isPlaybackActive;
    this.isCallActive = options.isCallActive;
    this.canArmListening = options.canArmListening;
    this.isListening = options.isListening;
    this.onArmListening = options.onArmListening;

    const rawPreRoll = env.STT_PRE_ROLL_MS;
    const preRollMs = Math.min(
      PREROLL_MAX_MS,
      Math.max(PREROLL_MIN_MS, Math.floor(Number.isFinite(rawPreRoll) ? rawPreRoll : PREROLL_DEFAULT_MS)),
    );

    this.ringBuffer = new InboundPcm16RingBuffer({
      sampleRateHz: options.sampleRateHz,
      maxMs: preRollMs,
    });
  }

  public getState(): AudioState {
    return this.state;
  }

  public isEnding(): boolean {
    return this.state === 'ENDING';
  }

  public isMediaReady(): boolean {
    return this.mediaReady;
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

  public onPlaybackEnded(ts: number = Date.now(), reason: string = 'playback_ended'): void {
    this.playbackEndedAtMs = ts;
    if (this.ttsStartAtMs > 0 && this.ttsEndAtMs === 0) {
      this.ttsEndAtMs = ts;
    }
    this.maybeArmListening(reason, ts);
  }

  public onTtsStart(ts: number = Date.now(), reason: string = 'tts_playback_start'): void {
    if (this.state !== 'ENDING') {
      this.transition('PLAYING', reason, ts);
    }
    if (this.ttsStartAtMs === 0) {
      this.ttsStartAtMs = ts;
      this.ttsEndAtMs = 0;
    }
  }

  public notifyListeningEligibilityChanged(reason: string, ts: number = Date.now()): void {
    this.maybeArmListening(reason, ts);
  }

  public consumePreRollForUtterance(): Pcm16RingSnapshot | null {
    return this.ringBuffer.snapshot();
  }

  public onSpeechStart(prependedMs: number | undefined, ts: number = Date.now()): void {
    if (this.state === 'ENDING') return;

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

  public onUtteranceEnd(info: UtteranceEndInfo, ts: number = Date.now()): void {
    if (this.state === 'ENDING') return;

    this.utteranceTotalMs = Math.max(0, Math.round(info.utteranceMs));
    this.speechMs = Math.max(0, Math.round(info.speechMs));
    this.trailingSilenceMs = Math.max(0, Math.round(info.trailingSilenceMs));
    if (Number.isFinite(info.preRollMs)) {
      this.preRollMs = Math.max(0, Math.round(info.preRollMs));
    }

    this.summaryPending = true;
    this.transition('FINALIZING_STT', 'utterance_end', ts);
  }

  public onRespondingStart(ts: number = Date.now()): void {
    if (this.state === 'ENDING') return;
    this.transition('RESPONDING', 'responding_start', ts);
  }

  public onSttRequestStart(kind: 'partial' | 'final', ts: number = Date.now()): void {
    if (kind !== 'final') return;
    this.finalInFlight = true;
    if (this.sttReqStartAtMs === 0) this.sttReqStartAtMs = ts;
    log.info(
      {
        event: 'audio_stt_req_start',
        call_control_id: this.callControlId,
        kind,
        ts,
        ...(this.logContext ?? {}),
      },
      'audio stt request start',
    );
  }

  public onSttRequestEnd(kind: 'partial' | 'final', ts: number = Date.now()): void {
    if (kind !== 'final') return;
    this.finalInFlight = false;
    this.sttReqEndAtMs = ts;
    log.info(
      {
        event: 'audio_stt_req_end',
        call_control_id: this.callControlId,
        kind,
        ts,
        ...(this.logContext ?? {}),
      },
      'audio stt request end',
    );
  }

  public onHangup(ts: number = Date.now(), reason: string = 'hangup'): void {
    if (this.hangupReceivedAtMs === 0) {
      this.hangupReceivedAtMs = ts;
    }
    log.info(
      {
        event: 'audio_hangup_received',
        call_control_id: this.callControlId,
        reason,
        ts,
        ...(this.logContext ?? {}),
      },
      'audio hangup received',
    );
    this.transition('ENDING', reason, ts);
  }

  public shouldFinalizeOnDisconnect(): boolean {
    const shouldFinalize = this.state === 'CAPTURING' || this.sawSpeech;
    log.info(
      {
        event: 'audio_disconnect_finalize_decision',
        call_control_id: this.callControlId,
        state: this.state,
        saw_speech: this.sawSpeech,
        should_finalize: shouldFinalize,
        ...(this.logContext ?? {}),
      },
      'audio disconnect finalize decision',
    );
    return shouldFinalize;
  }

  public isFinalInFlight(): boolean {
    return this.finalInFlight;
  }

  private resetUtteranceTiming(): void {
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
    if (this.state === 'ENDING') return;
    if (!this.isCallActive()) return;
    if (!this.canArmListening()) return;

    const playbackActive = this.isPlaybackActive();
    const mediaReady = this.mediaReady;
    if (playbackActive || !mediaReady) return;

    if (this.state === 'CAPTURING' || this.state === 'FINALIZING_STT' || this.state === 'RESPONDING') {
      return;
    }

    if (this.isListening()) {
      return;
    }

    this.sttArmedAtMs = ts;
    this.transition('LISTENING', reason, ts);
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

  private transition(next: AudioState, reason: string, ts: number): void {
    if (this.state === next) {
      return;
    }
    const prev = this.state;
    this.state = next;

    log.info(
      {
        event: 'audio_state_transition',
        from: prev,
        to: next,
        reason,
        call_control_id: this.callControlId,
        ts,
        ...(this.logContext ?? {}),
      },
      'audio state transition',
    );

    if (this.summaryPending && (next === 'LISTENING' || next === 'ENDING')) {
      this.emitTimingSummary(ts);
    }
  }

  private emitTimingSummary(ts: number): void {
    if (!this.summaryPending) return;
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
      delta_playback_to_first_frame_ms:
        this.playbackEndedAtMs && this.firstFrameAtMs ? this.firstFrameAtMs - this.playbackEndedAtMs : null,
      delta_first_frame_to_armed_ms:
        this.firstFrameAtMs && this.sttArmedAtMs ? this.sttArmedAtMs - this.firstFrameAtMs : null,
      delta_armed_to_speech_ms:
        this.sttArmedAtMs && this.utteranceStartAtMs ? this.utteranceStartAtMs - this.sttArmedAtMs : null,
      summary_ts: ts,
    };

    log.info(summary, 'timing summary');

    this.utteranceStartAtMs = 0;
    this.sawSpeech = false;
  }
}
