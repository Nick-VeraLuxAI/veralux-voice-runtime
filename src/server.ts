import { randomUUID } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { env } from './env';
import { SessionManager } from './calls/sessionManager';
import { log } from './log';
import { healthRouter } from './routes/health';
import { createTelnyxWebhookRouter } from './routes/telnyxWebhook';

type RequestWithRawBody = Request & { rawBody?: Buffer; id?: string };

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  const requestId = incomingId && incomingId.trim() !== '' ? incomingId : randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as RequestWithRawBody).id = requestId;
  next();
}

function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_server_error' });
}

const MEDIA_PATH_PREFIX = '/v1/telnyx/media/';

function parseMediaRequest(request: http.IncomingMessage): { callControlId: string; token: string | null } | null {
  if (!request.url) {
    return null;
  }

  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url, `http://${host}`);
  if (!url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
    return null;
  }

  const callControlId = url.pathname.slice(MEDIA_PATH_PREFIX.length);
  if (!callControlId || callControlId.includes('/')) {
    return null;
  }

  return {
    callControlId,
    token: url.searchParams.get('token'),
  };
}

function attachMediaWebSocketServer(
  server: http.Server,
  sessionManager: SessionManager,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const parsed = parseMediaRequest(request);
    if (!parsed) {
      socket.destroy();
      return;
    }

    if (!parsed.token || parsed.token !== env.MEDIA_STREAM_TOKEN) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as WebSocket & { callControlId?: string }).callControlId = parsed.callControlId;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    const callControlId = (ws as WebSocket & { callControlId?: string }).callControlId;

    if (!callControlId) {
      ws.close(1008, 'invalid_call_control_id');
      return;
    }

    sessionManager.registerMediaConnection(callControlId, ws);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        return;
      }

      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      const ok = sessionManager.pushAudio(callControlId, buffer);
      if (!ok) {
        ws.close(1008, 'session_not_found');
      }
    });

    ws.on('close', () => {
      sessionManager.unregisterMediaConnection(callControlId, ws);
    });

    ws.on('error', (error) => {
      sessionManager.unregisterMediaConnection(callControlId, ws);
      log.error({ err: error, call_control_id: callControlId }, 'media websocket error');
    });
  });

  return wss;
}

export function buildServer(): { app: express.Express; server: http.Server; sessionManager: SessionManager } {
  const app = express();
  const sessionManager = new SessionManager();

  app.disable('x-powered-by');
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    }),
  );
  app.use(requestIdMiddleware);

  app.use('/health', healthRouter);
  app.use('/v1/telnyx/webhook', createTelnyxWebhookRouter(sessionManager));

  app.use(errorHandler);

  const server = http.createServer(app);
  attachMediaWebSocketServer(server, sessionManager);

  return { app, server, sessionManager };
}
