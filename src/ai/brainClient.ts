import { env } from '../env';
import { log } from '../log';
import { ConversationTurn } from '../calls/types';
import { defaultBrainReply } from './defaultBrain';

export interface AssistantReplyInput {
  tenantId?: string;
  callControlId: string;
  transcript: string;
  history: ConversationTurn[];
}

export type AssistantReplySource =
  | 'brain_http'
  | 'brain_http_stream'
  | 'brain_local_default'
  | 'fallback_error';

export interface AssistantReplyResult {
  text: string;
  source: AssistantReplySource;
}

const ERROR_FALLBACK_TEXT = 'Sorry - I had a problem responding. Can you repeat that?';

function buildBrainUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  if (trimmed.endsWith('/reply/stream')) {
    return trimmed.replace(/\/reply\/stream$/, '/reply');
  }
  if (trimmed.endsWith('/reply')) {
    return trimmed;
  }
  return `${trimmed}/reply`;
}

function buildBrainStreamUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  if (trimmed.endsWith('/reply/stream')) {
    return trimmed;
  }
  let path = env.BRAIN_STREAM_PATH;
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  if (trimmed.endsWith('/reply') && path.startsWith('/reply/')) {
    path = path.slice('/reply'.length);
  }
  return `${trimmed}${path}`;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

async function readSseStream(
  response: Response,
  onEvent: (event: { event: string; data: string }) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error('brain stream missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundaryIndex = buffer.indexOf('\n\n');
    while (boundaryIndex !== -1) {
      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        onEvent(parsed);
      }
      boundaryIndex = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');

  const trailing = buffer.trim();
  if (trailing) {
    const parsed = parseSseBlock(trailing);
    if (parsed) {
      onEvent(parsed);
    }
  }
}

export async function generateAssistantReply(
  input: AssistantReplyInput,
): Promise<AssistantReplyResult> {
  if (!env.BRAIN_URL) {
    const text = defaultBrainReply({ transcript: input.transcript, tenantId: input.tenantId });
    log.info(
      {
        event: 'brain_route',
        source: 'brain_local_default',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        has_brain_url: false,
      },
      'brain routed to local default',
    );
    return { text, source: 'brain_local_default' };
  }

  const url = buildBrainUrl(env.BRAIN_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.BRAIN_TIMEOUT_MS);

  try {
    log.info(
      {
        event: 'brain_route',
        source: 'brain_http',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        has_brain_url: true,
      },
      'brain routed to http',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        transcript: input.transcript,
        history: input.history,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      throw new Error(`brain reply failed ${response.status}: ${preview}`);
    }

    const data = (await response.json()) as { text?: unknown };
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) {
      throw new Error('brain reply missing text');
    }

    return { text, source: 'brain_http' };
  } catch (error) {
    log.error(
      {
        err: error,
        event: 'brain_reply_failed',
        call_control_id: input.callControlId,
        tenant_id: input.tenantId,
      },
      'brain reply failed',
    );
    return { text: ERROR_FALLBACK_TEXT, source: 'fallback_error' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateAssistantReplyStream(
  input: AssistantReplyInput,
  onToken: (chunk: string) => void,
): Promise<AssistantReplyResult> {
  if (!env.BRAIN_URL || !env.BRAIN_STREAMING_ENABLED) {
    return generateAssistantReply(input);
  }

  const streamUrl = buildBrainStreamUrl(env.BRAIN_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.BRAIN_TIMEOUT_MS);
  const startedAt = Date.now();
  const tokenLogEvery = 10;

  let fullText = '';
  let tokenCount = 0;
  let sawTokens = false;

  try {
    log.info(
      {
        event: 'brain_route',
        source: 'brain_http_stream',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        has_brain_url: true,
      },
      'brain routed to stream',
    );

    const response = await fetch(streamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        transcript: input.transcript,
        history: input.history,
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const body = await readResponseText(response);
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      throw new Error(`brain stream failed ${response.status}: ${preview}`);
    }

    if (!contentType.includes('text/event-stream')) {
      throw new Error(`brain stream unsupported content-type: ${contentType}`);
    }

    log.info(
      {
        event: 'brain_stream_start',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream start',
    );

    await readSseStream(response, ({ event, data }) => {
      if (event === 'ping' || event === 'meta') {
        return;
      }

      let payload: unknown;
      if (data) {
        try {
          payload = JSON.parse(data);
        } catch {
          payload = undefined;
        }
      }

      if (event === 'token') {
        const chunk = payload && typeof (payload as { t?: unknown }).t === 'string'
          ? (payload as { t: string }).t
          : '';
        if (!chunk) {
          return;
        }
        sawTokens = true;
        fullText += chunk;
        tokenCount += 1;
        if (tokenCount % tokenLogEvery === 0) {
          log.info(
            {
              event: 'brain_stream_token',
              chunk_len: chunk.length,
              total_len: fullText.length,
              tenant_id: input.tenantId,
              call_control_id: input.callControlId,
            },
            'brain stream token',
          );
        }
        onToken(chunk);
        return;
      }

      if (event === 'done') {
        const text = payload && typeof (payload as { text?: unknown }).text === 'string'
          ? (payload as { text: string }).text
          : '';
        if (text) {
          fullText = text;
        }
        return;
      }

      if (event === 'error') {
        const message =
          payload && typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : 'brain stream error';
        throw new Error(message);
      }
    });

    const trimmed = fullText.trim();
    if (!trimmed) {
      throw new Error('brain stream missing text');
    }

    const durationMs = Date.now() - startedAt;
    log.info(
      {
        event: 'brain_stream_done',
        total_len: trimmed.length,
        duration_ms: durationMs,
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream done',
    );

    return { text: trimmed, source: 'brain_http_stream' };
  } catch (error) {
    log.warn(
      {
        err: error,
        event: 'brain_stream_error',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream error',
    );
    if (sawTokens && fullText.trim()) {
      return { text: fullText.trim(), source: 'brain_http_stream' };
    }
    return generateAssistantReply(input);
  } finally {
    clearTimeout(timeout);
  }
}
