export interface TelnyxWebhookPayload {
  data?: {
    event_type?: string;
    payload?: Record<string, unknown>;
  };
}

export interface TelnyxCallPayload {
  call_control_id: string;
  tenant_id?: string;
  client_state?: string;
  [key: string]: unknown;
}

export interface CallInitiatedEvent {
  data: {
    event_type: 'call.initiated';
    payload: TelnyxCallPayload;
  };
}

export interface CallAnsweredEvent {
  data: {
    event_type: 'call.answered';
    payload: TelnyxCallPayload;
  };
}

export interface CallHangupEvent {
  data: {
    event_type: 'call.hangup' | 'call.ended';
    payload: TelnyxCallPayload;
  };
}

export interface TelnyxRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}