import crypto from 'crypto';
import { env } from '../env';

const MAX_SKEW_SECONDS = 300;

export interface TelnyxSignatureInput {
  rawBody: Buffer;
  signature: string;
  timestamp: string;
  scheme?: 'ed25519' | 'hmac-sha256';
}

export interface TelnyxEventMeta {
  eventType?: string;
  callControlId?: string;
  tenantId?: string;
}

export interface TelnyxSignatureCheck {
  ok: boolean;
  skipped: boolean;
}

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return undefined;
}

function parsePublicKey(publicKey: string): crypto.KeyObject {
  if (publicKey.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(publicKey);
  }

  const keyBuffer = Buffer.from(publicKey, isHex(publicKey) ? 'hex' : 'base64');
  return crypto.createPublicKey({ key: keyBuffer, format: 'der', type: 'spki' });
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function extractTenantIdFromClientState(clientState?: string): string | undefined {
  if (!clientState) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(clientState, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as { tenant_id?: unknown };
    return getString(parsed.tenant_id);
  } catch {
    return undefined;
  }
}

export function extractTelnyxEventMetaFromPayload(payload: unknown): TelnyxEventMeta {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return {};
  }

  const eventType = getString((data as { event_type?: unknown }).event_type);
  const payloadObj = (data as { payload?: unknown }).payload;
  if (!payloadObj || typeof payloadObj !== 'object') {
    return { eventType };
  }

  const callControlId = getString((payloadObj as { call_control_id?: unknown }).call_control_id);
  const tenantId =
    getString((payloadObj as { tenant_id?: unknown }).tenant_id) ||
    extractTenantIdFromClientState(getString((payloadObj as { client_state?: unknown }).client_state));

  return { eventType, callControlId, tenantId };
}

export function extractTelnyxEventMetaFromRawBody(rawBody: Buffer): TelnyxEventMeta {
  if (!rawBody || rawBody.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    return extractTelnyxEventMetaFromPayload(parsed);
  } catch {
    return {};
  }
}

function verifyHmacSignature(message: Buffer, signature: string, secret: string): boolean {
  const digest = crypto.createHmac('sha256', secret).update(message).digest();
  const signatureBuffer = Buffer.from(signature, isHex(signature) ? 'hex' : 'base64');

  if (signatureBuffer.length !== digest.length) {
    return false;
  }

  return crypto.timingSafeEqual(digest, signatureBuffer);
}

export function verifyTelnyxSignature({
  rawBody,
  signature,
  timestamp,
  scheme,
}: TelnyxSignatureInput): TelnyxSignatureCheck {
  const verifyOverride = parseBoolEnv(process.env.TELNYX_VERIFY_SIGNATURES);
  const skipVerify = verifyOverride === false || (verifyOverride !== true && env.TELNYX_SKIP_SIGNATURE);
  if (skipVerify) {
    return { ok: true, skipped: true };
  }

  const trimmedSignature = signature?.trim() ?? '';
  const trimmedTimestamp = timestamp?.trim() ?? '';
  if (!trimmedSignature || !trimmedTimestamp) {
    return { ok: false, skipped: false };
  }

  const parsedTimestamp = Number.parseInt(trimmedTimestamp, 10);
  if (!Number.isFinite(parsedTimestamp)) {
    return { ok: false, skipped: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const normalizedTimestamp = parsedTimestamp > 1_000_000_000_000 ? Math.floor(parsedTimestamp / 1000) : parsedTimestamp;
  if (Math.abs(now - normalizedTimestamp) > MAX_SKEW_SECONDS) {
    return { ok: false, skipped: false };
  }

  const message = Buffer.concat([
    Buffer.from(trimmedTimestamp, 'utf8'),
    Buffer.from('.', 'utf8'),
    rawBody,
  ]);

  const secret = process.env.TELNYX_WEBHOOK_SECRET?.trim();
  const shouldUseHmac = scheme === 'hmac-sha256' || (!!secret && scheme !== 'ed25519');

  try {
    if (shouldUseHmac) {
      if (!secret) {
        return { ok: false, skipped: false };
      }
      return { ok: verifyHmacSignature(message, trimmedSignature, secret), skipped: false };
    }

    const publicKeyRaw = env.TELNYX_PUBLIC_KEY?.trim();
    if (!publicKeyRaw) {
      return { ok: false, skipped: false };
    }

    const publicKey = parsePublicKey(publicKeyRaw);
    const signatureBuffer = Buffer.from(trimmedSignature, isHex(trimmedSignature) ? 'hex' : 'base64');
    return { ok: crypto.verify(null, message, publicKey, signatureBuffer), skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}
