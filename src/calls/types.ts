import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import type { TransportSession } from '../transport/types';

export type CallSessionId = string;

export type CallSessionState =
  | 'INIT'
  | 'ANSWERED'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'ENDED';


export type TranscriptSegment = string;
export type TranscriptBuffer = TranscriptSegment[];

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface CallSessionMetrics {
  createdAt: Date;
  lastHeardAt?: Date;
  turns: number;
  /** Tier 5: transcripts received (final) this call */
  transcriptsTotal: number;
  /** Tier 5: transcripts that were empty (Whisper returned nothing) */
  transcriptsEmpty: number;
  /** Tier 5: total utterance audio ms sent to Whisper */
  totalUtteranceMs: number;
  /** Tier 5: total transcribed character count */
  totalTranscribedChars: number;
}

export interface CallSessionConfig {
  callControlId: CallSessionId;
  tenantId?: string;
  from?: string;
  to?: string;
  requestId?: string;
  tenantConfig?: RuntimeTenantConfig;
  transportSession?: TransportSession;
}