// src/stt/debugSttTrace.ts
import crypto from 'crypto';
import { log } from '../log';

function parseBool(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

export const STT_TRACE_ENABLED = (() => {
  const v = process.env.STT_TRACE;
  return v == null ? false : parseBool(v);
})();

const DEFAULT_LIMIT = 12;
const LIMIT = (() => {
  const n = Number.parseInt(process.env.STT_TRACE_LIMIT ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
})();

// per callId counter
const counters = new Map<string, number>();

export function shouldTrace(callId: string): boolean {
  if (!STT_TRACE_ENABLED) return false;
  if (LIMIT === 0) return true;
  const n = (counters.get(callId) ?? 0) + 1;
  counters.set(callId, n);
  return n <= LIMIT;
}

export function sha1_10(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
}

export function traceInfo(callId: string, obj: Record<string, unknown>, msg: string): void {
  if (!shouldTrace(callId)) return;
  log.info({ ...obj, call_id: callId }, msg);
}

export function traceWarn(callId: string, obj: Record<string, unknown>, msg: string): void {
  if (!shouldTrace(callId)) return;
  log.warn({ ...obj, call_id: callId }, msg);
}
