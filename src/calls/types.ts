export type CallSessionId = string;

export type CallSessionState = 'INIT' | 'ANSWERED' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ENDED';

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
}

export interface CallSessionConfig {
  callControlId: CallSessionId;
  tenantId?: string;
  from?: string;
  to?: string;
  requestId?: string;
}
