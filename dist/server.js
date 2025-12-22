"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const env_1 = require("./env");
const sessionManager_1 = require("./calls/sessionManager");
const log_1 = require("./log");
const health_1 = require("./routes/health");
const telnyxWebhook_1 = require("./routes/telnyxWebhook");
function requestIdMiddleware(req, res, next) {
    const incomingId = req.header('x-request-id');
    const requestId = incomingId && incomingId.trim() !== '' ? incomingId : (0, crypto_1.randomUUID)();
    res.setHeader('x-request-id', requestId);
    req.id = requestId;
    next();
}
function errorHandler(err, _req, res, _next) {
    log_1.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal_server_error' });
}
const MEDIA_PATH_PREFIX = '/v1/telnyx/media/';
function parseMediaRequest(request) {
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
function attachMediaWebSocketServer(server, sessionManager) {
    const wss = new ws_1.WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        const parsed = parseMediaRequest(request);
        if (!parsed) {
            socket.destroy();
            return;
        }
        if (!parsed.token || parsed.token !== env_1.env.MEDIA_STREAM_TOKEN) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.callControlId = parsed.callControlId;
            wss.emit('connection', ws, request);
        });
    });
    wss.on('connection', (ws) => {
        const callControlId = ws.callControlId;
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
                    : Buffer.from(data);
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
            log_1.log.error({ err: error, call_control_id: callControlId }, 'media websocket error');
        });
    });
    return wss;
}
function buildServer() {
    const app = (0, express_1.default)();
    const sessionManager = new sessionManager_1.SessionManager();
    app.disable('x-powered-by');
    app.use(express_1.default.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    }));
    app.use(requestIdMiddleware);
    app.use('/health', health_1.healthRouter);
    app.use('/v1/telnyx/webhook', (0, telnyxWebhook_1.createTelnyxWebhookRouter)(sessionManager));
    app.use(errorHandler);
    const server = http_1.default.createServer(app);
    attachMediaWebSocketServer(server, sessionManager);
    return { app, server, sessionManager };
}
//# sourceMappingURL=server.js.map