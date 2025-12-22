import { env } from '../env';
import { log } from '../log';
import { MediaFrame } from '../media/types';
import { storeWav } from '../storage/audioStore';
import { ChunkedSTT } from '../stt/chunkedSTT';
import { TelnyxClient } from '../telnyx/telnyxClient';
import { synthesizeSpeech } from '../tts/kokoroTTS';
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
  private isHandlingTranscript = false;
  private hasStarted = false;
  private turnSequence = 0;
  private deadAirTimer?: NodeJS.Timeout;
  private repromptInFlight = false;

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
    this.logContext = {
      call_control_id: this.callControlId,
      tenant_id: this.tenantId,
      requestId: this.requestId,
    };
    this.telnyx = new TelnyxClient(this.logContext);

    this.stt = new ChunkedSTT({
      chunkMs: env.STT_CHUNK_MS,
      silenceMs: env.STT_SILENCE_MS,
      onTranscript: async (text) => {
        await this.handleTranscript(text);
      },
      logContext: this.logContext,
    });
  }

  public start(options: { autoAnswer?: boolean } = {}): boolean {
    if (this.state === 'ENDED' || this.hasStarted) {
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
    if (this.state === 'ENDED') {
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
    if (this.state === 'ENDED') {
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
      return false;
    }

    this.state = 'ENDED';
    this.metrics.lastHeardAt = new Date();
    this.clearDeadAirTimer();
    this.stt.stop();
    return true;
  }

  public getState(): CallSessionState {
    return this.state;
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
    if (this.state === 'ENDED') {
      return;
    }

    this.state = 'LISTENING';
    this.scheduleDeadAirTimer();
  }

  private scheduleDeadAirTimer(): void {
    if (this.state !== 'LISTENING') {
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
    if (this.state !== 'LISTENING' || this.state === 'ENDED' || this.repromptInFlight) {
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
    if (this.state !== 'LISTENING' || this.isHandlingTranscript) {
      return;
    }

    this.isHandlingTranscript = true;
    this.clearDeadAirTimer();

    try {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }

      this.state = 'THINKING';
      this.appendTranscriptSegment(trimmed);
      this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });

      const response = await this.mockAiTurn(trimmed);
      this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });

      await this.playAssistantTurn(response);
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
    } finally {
      if (this.state !== 'ENDED') {
        this.enterListeningState();
      }
      this.isHandlingTranscript = false;
    }
  }

  private async mockAiTurn(transcript: string): Promise<string> {
    void transcript;
    return 'Acknowledged.';
  }

  private async answerAndGreet(): Promise<void> {
    try {
      const answerStarted = Date.now();
      await this.telnyx.answerCall(this.callControlId);
      const answerDuration = Date.now() - answerStarted;

      log.info(
        { event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext },
        'telnyx answer completed',
      );

      this.onAnswered();
      await this.playText('Hello, thanks for calling.', 'greeting');
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call start greeting failed');
    }
  }

  private async playAssistantTurn(text: string): Promise<void> {
    const turnId = `turn-${this.nextTurnId()}`;
    await this.playText(text, turnId);
  }

  private async playText(text: string, turnId: string): Promise<void> {
    if (this.state === 'ENDED') {
      return;
    }

    this.clearDeadAirTimer();
    this.state = 'SPEAKING';

    try {
      const ttsStart = Date.now();
      const result = await synthesizeSpeech({ text });
      const ttsDuration = Date.now() - ttsStart;
      log.info(
        { event: 'tts_synthesized', duration_ms: ttsDuration, audio_bytes: result.audio.length, ...this.logContext },
        'tts synthesized',
      );

      const publicUrl = await storeWav(this.callControlId, turnId, result.audio);

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
      if (this.state !== 'ENDED') {
        this.enterListeningState();
      }
    }
  }

  private nextTurnId(): number {
    this.turnSequence += 1;
    return this.turnSequence;
  }
}
