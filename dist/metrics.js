"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsMiddleware = void 0;
exports.metricsHandler = metricsHandler;
exports.startStageTimer = startStageTimer;
exports.observeStageDuration = observeStageDuration;
exports.incStageError = incStageError;
exports.incInboundAudioFrames = incInboundAudioFrames;
exports.incSttFramesFed = incSttFramesFed;
exports.incInboundAudioFramesDropped = incInboundAudioFramesDropped;
exports.recordCallMetrics = recordCallMetrics;
const prom_client_1 = __importDefault(require("prom-client"));
/**
 * Runtime Prometheus metrics
 *
 * IMPORTANT NOTE:
 * prom-client Histogram.startTimer() measures SECONDS.
 * This module records TRUE milliseconds to match *_ms metric names.
 */
const register = new prom_client_1.default.Registry();
const METRICS_PREFIX = 'veralux_voice_runtime_';
// Default node/process metrics
prom_client_1.default.collectDefaultMetrics({
    register,
    prefix: METRICS_PREFIX,
});
// HTTP request duration in milliseconds
const httpRequestDurationMs = new prom_client_1.default.Histogram({
    name: `${METRICS_PREFIX}http_request_duration_ms`,
    help: 'HTTP request duration in milliseconds (Express)',
    labelNames: ['method', 'route', 'code'],
    // Reasonable ms buckets for APIs
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000],
    registers: [register],
});
// Pipeline stage duration in milliseconds (STT/LLM/TTS/etc.)
const stageDurationMs = new prom_client_1.default.Histogram({
    name: `${METRICS_PREFIX}stage_duration_ms`,
    help: 'Stage duration in milliseconds (STT/LLM/TTS/etc.)',
    labelNames: ['stage', 'tenant'],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 60000],
    registers: [register],
});
const stageErrorsTotal = new prom_client_1.default.Counter({
    name: `${METRICS_PREFIX}stage_errors_total`,
    help: 'Count of errors by stage (STT/LLM/TTS/etc.)',
    labelNames: ['stage', 'tenant'],
    registers: [register],
});
const inboundAudioFramesTotal = new prom_client_1.default.Counter({
    name: `${METRICS_PREFIX}inbound_audio_frames_total`,
    help: 'Inbound audio frames received (pre-STT)',
    registers: [register],
});
const sttFramesFedTotal = new prom_client_1.default.Counter({
    name: `${METRICS_PREFIX}stt_frames_fed_total`,
    help: 'Audio frames fed into STT ingest',
    registers: [register],
});
const inboundAudioFramesDroppedTotal = new prom_client_1.default.Counter({
    name: `${METRICS_PREFIX}inbound_audio_frames_dropped_total`,
    help: 'Inbound audio frames dropped before STT',
    labelNames: ['reason'],
    registers: [register],
});
// Tier 5: per-call metrics
const callCompletionsTotal = new prom_client_1.default.Counter({
    name: `${METRICS_PREFIX}call_completions_total`,
    help: 'Calls completed (teardown)',
    labelNames: ['tenant', 'reason'],
    registers: [register],
});
const callDurationSeconds = new prom_client_1.default.Histogram({
    name: `${METRICS_PREFIX}call_duration_seconds`,
    help: 'Call duration in seconds',
    labelNames: ['tenant'],
    buckets: [5, 10, 30, 60, 120, 300],
    registers: [register],
});
const callTurns = new prom_client_1.default.Histogram({
    name: `${METRICS_PREFIX}call_turns`,
    help: 'Number of turns per call',
    labelNames: ['tenant'],
    buckets: [0, 1, 2, 3, 5, 10, 20],
    registers: [register],
});
const callEmptyTranscriptPct = new prom_client_1.default.Histogram({
    name: `${METRICS_PREFIX}call_empty_transcript_pct`,
    help: 'Percentage of empty transcripts per call (0-100)',
    labelNames: ['tenant'],
    buckets: [0, 5, 10, 25, 50, 75, 100],
    registers: [register],
});
// ---------- helpers ----------
function nowNs() {
    return process.hrtime.bigint();
}
function nsToMs(ns) {
    return Number(ns) / 1000000;
}
// Avoid high-cardinality route labels
function getRouteLabel(req) {
    const routePath = req.route?.path;
    const baseUrl = req.baseUrl;
    if (routePath)
        return baseUrl ? `${baseUrl}${routePath}` : routePath;
    const raw = req.path || req.url || 'unknown';
    return raw
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
        .replace(/\b[0-9a-f]{16,}\b/gi, ':id')
        .replace(/\b\d{6,}\b/g, ':n');
}
// ---------- exports used by server ----------
const metricsMiddleware = (req, res, next) => {
    const start = nowNs();
    res.on('finish', () => {
        try {
            const durationMs = nsToMs(nowNs() - start);
            httpRequestDurationMs.observe({
                method: req.method,
                route: getRouteLabel(req),
                code: String(res.statusCode),
            }, durationMs);
        }
        catch {
            // never break requests due to metrics
        }
    });
    next();
};
exports.metricsMiddleware = metricsMiddleware;
async function metricsHandler(_req, res) {
    res.setHeader('Content-Type', register.contentType);
    res.status(200).send(await register.metrics());
}
// ---------- stage timing API ----------
/**
 * Starts a stage timer and returns an end() function.
 * Records TRUE milliseconds in stageDurationMs.
 */
function startStageTimer(stage, tenant) {
    const start = nowNs();
    const tenantLabel = tenant ?? 'unknown';
    return () => {
        try {
            const durationMs = nsToMs(nowNs() - start);
            stageDurationMs.observe({ stage, tenant: tenantLabel }, durationMs);
        }
        catch {
            // swallow
        }
    };
}
/**
 * Manual stage observation (used for precomputed durations like pre_stt_gate).
 */
function observeStageDuration(stage, tenant, durationMs) {
    try {
        stageDurationMs.observe({ stage, tenant: tenant ?? 'unknown' }, durationMs);
    }
    catch {
        // swallow
    }
}
function incStageError(stage, tenant) {
    stageErrorsTotal.inc({ stage, tenant: tenant ?? 'unknown' });
}
function incInboundAudioFrames(count = 1) {
    inboundAudioFramesTotal.inc(count);
}
function incSttFramesFed(count = 1) {
    sttFramesFedTotal.inc(count);
}
function incInboundAudioFramesDropped(reason, count = 1) {
    const label = reason && reason.trim() !== '' ? reason : 'unknown';
    inboundAudioFramesDroppedTotal.inc({ reason: label }, count);
}
/** Tier 5: record per-call metrics at teardown */
function recordCallMetrics(opts) {
    try {
        const tenant = opts.tenantId ?? 'unknown';
        const reason = opts.reason ?? 'unknown';
        callCompletionsTotal.inc({ tenant, reason });
        callDurationSeconds.observe({ tenant }, opts.durationMs / 1000);
        callTurns.observe({ tenant }, opts.turns);
        const emptyPct = opts.transcriptsTotal > 0
            ? (100 * opts.transcriptsEmpty) / opts.transcriptsTotal
            : 0;
        callEmptyTranscriptPct.observe({ tenant }, emptyPct);
    }
    catch {
        // swallow
    }
}
//# sourceMappingURL=metrics.js.map