import { env } from '../env';
import { log } from '../log';
import { MediaFrame } from '../media/types';
import { storeWav } from '../storage/audioStore';
import { ChunkedSTT } from '../stt/chunkedSTT';
import { TelnyxClient } from '../telnyx/telnyxClient';
import { synthesizeSpeech } from '../tts/kokoroTTS';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import { generateAssistantReply, generateAssistantReplyStream, type AssistantReplyResult } from '../ai/brainClient';
import {
  CallSessionConfig,
  CallSessionMetrics,
  CallSessionState,
  ConversationTurn,
  TranscriptBuffer,
} from './types';

export class CallSession {
  public readonly callControlId: string;
  public readonly tenantId?: string;
  public readonly from?: string;
  public readonly to?: string;
  public readonly requestId?: string;

  private state: CallSessionState = 'INIT';
  private readonly transcriptBuffer: TranscriptBuffer = [];
  private readonly conversationHistory: ConversationTurn[] = [];
  private readonly metrics: CallSessionMetrics;
  private readonly stt: ChunkedSTT;
  private readonly telnyx: TelnyxClient;
  private readonly logContext: Record<string, unknown>;
  private readonly deadAirMs = env.DEAD_AIR_MS;
  private readonly sttConfig?: RuntimeTenantConfig['stt'];
  private readonly ttsConfig?: RuntimeTenantConfig['tts'];
  private endedAt?: number;
  private endedReason?: string;
  private active = true;

  private isHandlingTranscript = false;
  private hasStarted = false;
  private turnSequence = 0;
  private deadAirTimer?: NodeJS.Timeout;
  private repromptInFlight = false;
  private readonly logPreviewChars = 160;
  private ttsSegmentChain: Promise<void> = Promise.resolve();
  private ttsSegmentQueueDepth = 0;

  constructor(config: CallSessionConfig) {
    this.callControlId = config.callControlId;
    this.tenantId = config.tenantId;
    this.from = config.from;
    this.to = config.to;
    this.requestId = config.requestId;

    this.metrics = {
      createdAt: new Date(),
      lastHeardAt: undefined,
      turns: 0,
    };

    this.sttConfig = config.tenantConfig?.stt;
    this.ttsConfig = config.tenantConfig?.tts;

    this.logContext = {
      call_control_id: this.callControlId,
      tenant_id: this.tenantId,
      requestId: this.requestId,
    };

    this.telnyx = new TelnyxClient(this.logContext);

    this.stt = new ChunkedSTT({
      chunkMs: this.sttConfig?.chunkMs ?? env.STT_CHUNK_MS,
      silenceMs: env.STT_SILENCE_MS,
      whisperUrl: this.sttConfig?.whisperUrl,
      language: this.sttConfig?.language,
      onTranscript: async ({ text, isFinal }) => {
        if (!isFinal) {
          return;
        }
        await this.handleTranscript(text);
      },
      logContext: this.logContext,
    });
  }

  public start(options: { autoAnswer?: boolean } = {}): boolean {
    if (!this.active || this.state === 'ENDED' || this.hasStarted) {
      return false;
    }

    this.state = 'INIT';
    this.hasStarted = true;

    if (options.autoAnswer !== false) {
      void this.answerAndGreet();
    }

    return true;
  }

  public onAnswered(): boolean {
    if (!this.active || this.state === 'ENDED') {
      return false;
    }

    const previousState = this.state;
    if (this.state === 'INIT') {
      this.state = 'ANSWERED';
    }

    this.metrics.lastHeardAt = new Date();
    return previousState !== this.state;
  }

  public onAudioFrame(frame: MediaFrame): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    if (this.state === 'INIT' || this.state === 'ANSWERED') {
      this.enterListeningState();
    } else if (this.state === 'LISTENING') {
      this.scheduleDeadAirTimer();
    }

    this.metrics.lastHeardAt = new Date();

    if (this.state === 'LISTENING') {
      this.stt.ingest(frame);
    }
  }

  public end(): boolean {
    if (this.state === 'ENDED') {
      this.markEnded('ended');
      return false;
    }

    this.markEnded('ended');
    this.state = 'ENDED';
    this.metrics.lastHeardAt = new Date();
    this.clearDeadAirTimer();
    this.stt.stop();
    return true;
  }

  public getState(): CallSessionState {
    return this.state;
  }

  public isActive(): boolean {
    return this.active;
  }

  public markEnded(reason: string): void {
    if (!this.active) {
      if (!this.endedReason) {
        this.endedReason = reason;
      }
      return;
    }

    this.active = false;
    this.endedAt = Date.now();
    this.endedReason = reason;
    log.info(
      { event: 'call_marked_inactive', reason, ...this.logContext },
      'call marked inactive',
    );
  }

  public getEndInfo(): { endedAt?: number; endedReason?: string } {
    return {
      endedAt: this.endedAt,
      endedReason: this.endedReason,
    };
  }

  public getMetrics(): CallSessionMetrics {
    return {
      createdAt: new Date(this.metrics.createdAt),
      lastHeardAt: this.metrics.lastHeardAt ? new Date(this.metrics.lastHeardAt) : undefined,
      turns: this.metrics.turns,
    };
  }

  public getLastActivityAt(): Date {
    return this.metrics.lastHeardAt ?? this.metrics.createdAt;
  }

  public appendTranscriptSegment(segment: string): void {
    if (segment.trim() === '') {
      return;
    }
    this.transcriptBuffer.push(segment);
  }

  public appendHistory(turn: ConversationTurn): void {
    this.conversationHistory.push(turn);
    this.metrics.turns += 1;
  }

  private enterListeningState(): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    this.state = 'LISTENING';
    this.scheduleDeadAirTimer();
  }

  private scheduleDeadAirTimer(): void {
    if (!this.active || this.state !== 'LISTENING') {
      return;
    }

    this.clearDeadAirTimer();
    this.deadAirTimer = setTimeout(() => {
      void this.handleDeadAirTimeout();
    }, this.deadAirMs);
    this.deadAirTimer.unref?.();
  }

  private clearDeadAirTimer(): void {
    if (this.deadAirTimer) {
      clearTimeout(this.deadAirTimer);
      this.deadAirTimer = undefined;
    }
  }

  private async handleDeadAirTimeout(): Promise<void> {
    // FIX (TS2367): remove redundant `this.state === 'ENDED'` check.
    // If state isn't LISTENING, we already return.
    if (!this.active || this.state !== 'LISTENING' || this.repromptInFlight) {
      return;
    }

    if (this.isHandlingTranscript) {
      this.scheduleDeadAirTimer();
      return;
    }

    this.repromptInFlight = true;
    try {
      await this.playText('Are you still there?', `reprompt-${this.nextTurnId()}`);
      log.info({ event: 'call_session_reprompt', ...this.logContext }, 'dead air reprompt');
    } finally {
      this.repromptInFlight = false;
      if (this.state === 'LISTENING') {
        this.scheduleDeadAirTimer();
      }
    }
  }

  private async handleTranscript(text: string): Promise<void> {
    if (!this.active || this.state !== 'LISTENING' || this.isHandlingTranscript) {
      return;
    }

    this.isHandlingTranscript = true;
    this.clearDeadAirTimer();

    try {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }

      const transcriptPreview =
        trimmed.length <= this.logPreviewChars
          ? trimmed
          : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;
      log.info(
        {
          event: 'transcript_received',
          transcript_length: trimmed.length,
          transcript_preview: transcriptPreview,
          ...this.logContext,
        },
        'transcript received',
      );

      this.state = 'THINKING';
      this.appendTranscriptSegment(trimmed);
      this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });

      let response = '';
      let replySource = 'unknown';
      let playbackDone: Promise<void> | undefined;
      try {
        if (env.BRAIN_STREAMING_ENABLED) {
          const streamResult = await this.streamAssistantReply(trimmed);
          response = streamResult.reply.text;
          replySource = streamResult.reply.source;
          playbackDone = streamResult.playbackDone;
        } else {
          const reply = await generateAssistantReply({
            tenantId: this.tenantId,
            callControlId: this.callControlId,
            transcript: trimmed,
            history: this.conversationHistory,
          });
          response = reply.text;
          replySource = reply.source;
        }
      } catch (error) {
        response = 'Acknowledged.';
        replySource = 'fallback_error';
        log.error(
          { err: error, assistant_reply_source: replySource, ...this.logContext },
          'assistant reply generation failed',
        );
      }

      const replyPreview =
        response.length <= this.logPreviewChars
          ? response
          : `${response.slice(0, this.logPreviewChars - 3)}...`;
      log.info(
        {
          event: 'assistant_reply_text',
          assistant_reply_text: replyPreview,
          assistant_reply_length: response.length,
          assistant_reply_source: replySource,
          ...this.logContext,
        },
        'assistant reply text',
      );

      this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });

      if (env.BRAIN_STREAMING_ENABLED) {
        if (playbackDone) {
          await playbackDone;
        }
      } else {
        await this.playAssistantTurn(response);
      }
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
    } finally {
      // FIX (TS2367): call unconditionally; enterListeningState guards ENDED internally.
      this.enterListeningState();
      this.isHandlingTranscript = false;
    }
  }

  private async streamAssistantReply(
    transcript: string,
  ): Promise<{ reply: AssistantReplyResult; playbackDone?: Promise<void> }> {
    let bufferedText = '';
    let firstTokenAt: number | undefined;
    let speakCursor = 0;
    let firstSegmentQueued = false;
    let segmentIndex = 0;
    let queuedSegments = 0;
    let baseTurnId: string | undefined;
    const firstSegmentMin = env.BRAIN_STREAM_SEGMENT_MIN_CHARS;
    const nextSegmentMin = env.BRAIN_STREAM_SEGMENT_NEXT_CHARS;
    const firstAudioMaxMs = env.BRAIN_STREAM_FIRST_AUDIO_MAX_MS;

    const queueSegment = (segment: string): void => {
      const trimmed = segment.trim();
      if (!trimmed) {
        return;
      }
      const resolvedTurnId = baseTurnId ?? `turn-${this.nextTurnId()}`;
      baseTurnId = resolvedTurnId;
      segmentIndex += 1;
      queuedSegments += 1;
      const segmentId = `${resolvedTurnId}-${segmentIndex}`;
      this.queueTtsSegment(trimmed, segmentId);
    };

    const maybeQueueSegments = (force: boolean): void => {
      if (!this.active) {
        return;
      }

      while (true) {
        const pending = bufferedText.slice(speakCursor);
        if (!pending) {
          return;
        }

        if (!firstSegmentQueued) {
          const boundary = this.findSentenceBoundary(pending);
          if (boundary !== null) {
            queueSegment(pending.slice(0, boundary));
            speakCursor += boundary;
            firstSegmentQueued = true;
            continue;
          }

          if (pending.length >= firstSegmentMin) {
            const end = this.selectSegmentEnd(pending, firstSegmentMin);
            queueSegment(pending.slice(0, end));
            speakCursor += end;
            firstSegmentQueued = true;
            continue;
          }

          if (
            force ||
            (firstTokenAt && Date.now() - firstTokenAt >= firstAudioMaxMs)
          ) {
            queueSegment(pending);
            speakCursor += pending.length;
            firstSegmentQueued = true;
            continue;
          }

          return;
        }

        const boundary = this.findSentenceBoundary(pending);
        if (boundary !== null) {
          queueSegment(pending.slice(0, boundary));
          speakCursor += boundary;
          continue;
        }

        if (pending.length >= nextSegmentMin) {
          const end = this.selectSegmentEnd(pending, nextSegmentMin);
          queueSegment(pending.slice(0, end));
          speakCursor += end;
          continue;
        }

        if (force) {
          queueSegment(pending);
          speakCursor += pending.length;
        }
        return;
      }
    };

    const reply = await generateAssistantReplyStream(
      {
        tenantId: this.tenantId,
        callControlId: this.callControlId,
        transcript,
        history: this.conversationHistory,
      },
      (chunk) => {
        if (!chunk) {
          return;
        }
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
        }
        bufferedText += chunk;
        maybeQueueSegments(false);
      },
    );

    if (reply.source !== 'brain_http_stream') {
      return { reply, playbackDone: this.playAssistantTurn(reply.text) };
    }

    if (reply.text.length > bufferedText.length) {
      bufferedText = reply.text;
    }
    maybeQueueSegments(true);

    if (queuedSegments === 0) {
      return { reply, playbackDone: this.playAssistantTurn(reply.text) };
    }

    return { reply, playbackDone: this.waitForTtsSegmentQueue() };
  }

  private async answerAndGreet(): Promise<void> {
    try {
      if (this.shouldSkipTelnyxAction('answer')) {
        return;
      }
      const answerStarted = Date.now();
      await this.telnyx.answerCall(this.callControlId);
      const answerDuration = Date.now() - answerStarted;

      log.info(
        { event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext },
        'telnyx answer completed',
      );
      log.info({ event: 'call_answered', ...this.logContext }, 'call answered');

      this.onAnswered();

      const trimmedBaseUrl = env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
      const greetingUrl = `${trimmedBaseUrl}/greeting.wav`;

      if (this.shouldSkipTelnyxAction('playback_start')) {
        return;
      }
      await this.telnyx.playAudio(this.callControlId, greetingUrl);

      log.info(
        { event: 'call_playback_started', audio_url: greetingUrl, ...this.logContext },
        'playback started',
      );
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call start greeting failed');
    }
  }

  private async playAssistantTurn(text: string): Promise<void> {
    const turnId = `turn-${this.nextTurnId()}`;
    await this.playText(text, turnId);
  }

  private async playText(text: string, turnId: string): Promise<void> {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    this.clearDeadAirTimer();
    this.state = 'SPEAKING';

    try {
      const ttsStart = Date.now();
      const result = await synthesizeSpeech({
        text,
        voice: this.ttsConfig?.voice,
        format: this.ttsConfig?.format,
        sampleRate: this.ttsConfig?.sampleRate,
        kokoroUrl: this.ttsConfig?.kokoroUrl,
      });

      const ttsDuration = Date.now() - ttsStart;

      log.info(
        {
          event: 'tts_synthesized',
          duration_ms: ttsDuration,
          audio_bytes: result.audio.length,
          ...this.logContext,
        },
        'tts synthesized',
      );

      // Signature in your repo: storeWav(callControlId, turnId, wavBuffer)
      const publicUrl = await storeWav(this.callControlId, turnId, result.audio);

      if (this.shouldSkipTelnyxAction('playback_start')) {
        return;
      }
      const playbackStart = Date.now();
      await this.telnyx.playAudio(this.callControlId, publicUrl);
      const playbackDuration = Date.now() - playbackStart;

      log.info(
        {
          event: 'telnyx_playback_duration',
          duration_ms: playbackDuration,
          audio_url: publicUrl,
          ...this.logContext,
        },
        'telnyx playback completed',
      );
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call session tts playback failed');
    } finally {
      // FIX (TS2367): call unconditionally; enterListeningState guards ENDED internally.
      this.enterListeningState();
    }
  }

  private queueTtsSegment(segmentText: string, segmentId: string): void {
    if (!segmentText.trim()) {
      return;
    }
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    this.clearDeadAirTimer();
    this.state = 'SPEAKING';
    this.ttsSegmentQueueDepth += 1;
    const queueDepth = this.ttsSegmentQueueDepth;

    log.info(
      {
        event: 'tts_segment_queued',
        seg_len: segmentText.length,
        queue_depth: queueDepth,
        segment_id: segmentId,
        ...this.logContext,
      },
      'tts segment queued',
    );

    this.ttsSegmentChain = this.ttsSegmentChain
      .then(async () => {
        await this.playTtsSegment(segmentText, segmentId);
      })
      .catch((error) => {
        log.error({ err: error, ...this.logContext }, 'tts segment playback failed');
      })
      .finally(() => {
        this.ttsSegmentQueueDepth = Math.max(0, this.ttsSegmentQueueDepth - 1);
      });
  }

  private async playTtsSegment(segmentText: string, segmentId: string): Promise<void> {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    const ttsStart = Date.now();
    const result = await synthesizeSpeech({
      text: segmentText,
      voice: this.ttsConfig?.voice,
      format: this.ttsConfig?.format,
      sampleRate: this.ttsConfig?.sampleRate,
      kokoroUrl: this.ttsConfig?.kokoroUrl,
    });
    const ttsDuration = Date.now() - ttsStart;

    log.info(
      {
        event: 'tts_synthesized',
        duration_ms: ttsDuration,
        audio_bytes: result.audio.length,
        ...this.logContext,
      },
      'tts synthesized',
    );

    if (!this.active || this.state === 'ENDED') {
      return;
    }

    const publicUrl = await storeWav(this.callControlId, segmentId, result.audio);

    if (this.shouldSkipTelnyxAction('playback_start')) {
      return;
    }

    log.info(
      {
        event: 'tts_segment_play_start',
        seg_len: segmentText.length,
        segment_id: segmentId,
        audio_url: publicUrl,
        ...this.logContext,
      },
      'tts segment playback start',
    );

    const playbackStart = Date.now();
    await this.telnyx.playAudio(this.callControlId, publicUrl);
    const playbackDuration = Date.now() - playbackStart;

    log.info(
      {
        event: 'tts_segment_play_end',
        seg_len: segmentText.length,
        segment_id: segmentId,
        duration_ms: playbackDuration,
        audio_url: publicUrl,
        ...this.logContext,
      },
      'tts segment playback end',
    );
  }

  private waitForTtsSegmentQueue(): Promise<void> {
    return this.ttsSegmentChain;
  }

  private findSentenceBoundary(text: string): number | null {
    const match = text.match(/[.!?](?=\s|$)/);
    if (!match || match.index === undefined) {
      return null;
    }
    return match.index + 1;
  }

  private selectSegmentEnd(text: string, targetChars: number): number {
    if (text.length <= targetChars) {
      return text.length;
    }
    const slice = text.slice(0, targetChars);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= Math.floor(targetChars * 0.6)) {
      return lastSpace;
    }
    return targetChars;
  }

  private nextTurnId(): number {
    this.turnSequence += 1;
    return this.turnSequence;
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (this.active) {
      return false;
    }

    log.warn(
      { event: 'telnyx_action_skipped_inactive', action, ...this.logContext },
      'skipping telnyx action - call inactive',
    );
    return true;
  }
}
