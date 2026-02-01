import type { Request, Response, NextFunction, RequestHandler } from 'express';
import client from 'prom-client';

/**
 * Runtime Prometheus metrics
 *
 * IMPORTANT NOTE:
 * prom-client Histogram.startTimer() measures SECONDS.
 * This module records TRUE milliseconds to match *_ms metric names.
 */

const register = new client.Registry();
const METRICS_PREFIX = 'veralux_voice_runtime_';

// Default node/process metrics
client.collectDefaultMetrics({
  register,
  prefix: METRICS_PREFIX,
});

// HTTP request duration in milliseconds
const httpRequestDurationMs = new client.Histogram({
  name: `${METRICS_PREFIX}http_request_duration_ms`,
  help: 'HTTP request duration in milliseconds (Express)',
  labelNames: ['method', 'route', 'code'] as const,
  // Reasonable ms buckets for APIs
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000],
  registers: [register],
});

// Pipeline stage duration in milliseconds (STT/LLM/TTS/etc.)
const stageDurationMs = new client.Histogram({
  name: `${METRICS_PREFIX}stage_duration_ms`,
  help: 'Stage duration in milliseconds (STT/LLM/TTS/etc.)',
  labelNames: ['stage', 'tenant'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 60000],
  registers: [register],
});

const stageErrorsTotal = new client.Counter({
  name: `${METRICS_PREFIX}stage_errors_total`,
  help: 'Count of errors by stage (STT/LLM/TTS/etc.)',
  labelNames: ['stage', 'tenant'] as const,
  registers: [register],
});

const inboundAudioFramesTotal = new client.Counter({
  name: `${METRICS_PREFIX}inbound_audio_frames_total`,
  help: 'Inbound audio frames received (pre-STT)',
  registers: [register],
});

const sttFramesFedTotal = new client.Counter({
  name: `${METRICS_PREFIX}stt_frames_fed_total`,
  help: 'Audio frames fed into STT ingest',
  registers: [register],
});

const inboundAudioFramesDroppedTotal = new client.Counter({
  name: `${METRICS_PREFIX}inbound_audio_frames_dropped_total`,
  help: 'Inbound audio frames dropped before STT',
  labelNames: ['reason'] as const,
  registers: [register],
});

// Tier 5: per-call metrics
const callCompletionsTotal = new client.Counter({
  name: `${METRICS_PREFIX}call_completions_total`,
  help: 'Calls completed (teardown)',
  labelNames: ['tenant', 'reason'] as const,
  registers: [register],
});

const callDurationSeconds = new client.Histogram({
  name: `${METRICS_PREFIX}call_duration_seconds`,
  help: 'Call duration in seconds',
  labelNames: ['tenant'] as const,
  buckets: [5, 10, 30, 60, 120, 300],
  registers: [register],
});

const callTurns = new client.Histogram({
  name: `${METRICS_PREFIX}call_turns`,
  help: 'Number of turns per call',
  labelNames: ['tenant'] as const,
  buckets: [0, 1, 2, 3, 5, 10, 20],
  registers: [register],
});

const callEmptyTranscriptPct = new client.Histogram({
  name: `${METRICS_PREFIX}call_empty_transcript_pct`,
  help: 'Percentage of empty transcripts per call (0-100)',
  labelNames: ['tenant'] as const,
  buckets: [0, 5, 10, 25, 50, 75, 100],
  registers: [register],
});

// ---------- helpers ----------

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

// Avoid high-cardinality route labels
function getRouteLabel(req: Request): string {
  const routePath = (req as any).route?.path as string | undefined;
  const baseUrl = (req as any).baseUrl as string | undefined;

  if (routePath) return baseUrl ? `${baseUrl}${routePath}` : routePath;

  const raw = req.path || req.url || 'unknown';
  return raw
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
    .replace(/\b[0-9a-f]{16,}\b/gi, ':id')
    .replace(/\b\d{6,}\b/g, ':n');
}

// ---------- exports used by server ----------

export const metricsMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const start = nowNs();

  res.on('finish', () => {
    try {
      const durationMs = nsToMs(nowNs() - start);
      httpRequestDurationMs.observe(
        {
          method: req.method,
          route: getRouteLabel(req),
          code: String(res.statusCode),
        },
        durationMs,
      );
    } catch {
      // never break requests due to metrics
    }
  });

  next();
};

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', register.contentType);
  res.status(200).send(await register.metrics());
}

// ---------- stage timing API ----------

/**
 * Starts a stage timer and returns an end() function.
 * Records TRUE milliseconds in stageDurationMs.
 */
export function startStageTimer(stage: string, tenant: string | undefined): () => void {
  const start = nowNs();
  const tenantLabel = tenant ?? 'unknown';

  return () => {
    try {
      const durationMs = nsToMs(nowNs() - start);
      stageDurationMs.observe({ stage, tenant: tenantLabel }, durationMs);
    } catch {
      // swallow
    }
  };
}

/**
 * Manual stage observation (used for precomputed durations like pre_stt_gate).
 */
export function observeStageDuration(stage: string, tenant: string | undefined, durationMs: number): void {
  try {
    stageDurationMs.observe({ stage, tenant: tenant ?? 'unknown' }, durationMs);
  } catch {
    // swallow
  }
}

export function incStageError(stage: string, tenant: string | undefined): void {
  stageErrorsTotal.inc({ stage, tenant: tenant ?? 'unknown' });
}

export function incInboundAudioFrames(count = 1): void {
  inboundAudioFramesTotal.inc(count);
}

export function incSttFramesFed(count = 1): void {
  sttFramesFedTotal.inc(count);
}

export function incInboundAudioFramesDropped(reason: string, count = 1): void {
  const label = reason && reason.trim() !== '' ? reason : 'unknown';
  inboundAudioFramesDroppedTotal.inc({ reason: label }, count);
}

/** Tier 5: record per-call metrics at teardown */
export function recordCallMetrics(opts: {
  tenantId?: string;
  reason?: string;
  durationMs: number;
  turns: number;
  transcriptsTotal: number;
  transcriptsEmpty: number;
}): void {
  try {
    const tenant = opts.tenantId ?? 'unknown';
    const reason = opts.reason ?? 'unknown';
    callCompletionsTotal.inc({ tenant, reason });
    callDurationSeconds.observe({ tenant }, opts.durationMs / 1000);
    callTurns.observe({ tenant }, opts.turns);
    const emptyPct =
      opts.transcriptsTotal > 0
        ? (100 * opts.transcriptsEmpty) / opts.transcriptsTotal
        : 0;
    callEmptyTranscriptPct.observe({ tenant }, emptyPct);
  } catch {
    // swallow
  }
}
