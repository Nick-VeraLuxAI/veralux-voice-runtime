"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTelnyxEventMetaFromPayload = extractTelnyxEventMetaFromPayload;
exports.extractTelnyxEventMetaFromRawBody = extractTelnyxEventMetaFromRawBody;
exports.verifyTelnyxSignature = verifyTelnyxSignature;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../env");
const MAX_SKEW_SECONDS = 300;
function isHex(value) {
    return /^[0-9a-f]+$/i.test(value);
}
function parsePublicKey(publicKey) {
    if (publicKey.includes('BEGIN PUBLIC KEY')) {
        return crypto_1.default.createPublicKey(publicKey);
    }
    const keyBuffer = Buffer.from(publicKey, isHex(publicKey) ? 'hex' : 'base64');
    return crypto_1.default.createPublicKey({ key: keyBuffer, format: 'der', type: 'spki' });
}
function getString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function extractTenantIdFromClientState(clientState) {
    if (!clientState) {
        return undefined;
    }
    try {
        const decoded = Buffer.from(clientState, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return getString(parsed.tenant_id);
    }
    catch {
        return undefined;
    }
}
function extractTelnyxEventMetaFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return {};
    }
    const data = payload.data;
    if (!data || typeof data !== 'object') {
        return {};
    }
    const eventType = getString(data.event_type);
    const payloadObj = data.payload;
    if (!payloadObj || typeof payloadObj !== 'object') {
        return { eventType };
    }
    const callControlId = getString(payloadObj.call_control_id);
    const tenantId = getString(payloadObj.tenant_id) ||
        extractTenantIdFromClientState(getString(payloadObj.client_state));
    return { eventType, callControlId, tenantId };
}
function extractTelnyxEventMetaFromRawBody(rawBody) {
    if (!rawBody || rawBody.length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        return extractTelnyxEventMetaFromPayload(parsed);
    }
    catch {
        return {};
    }
}
function verifyHmacSignature(message, signature, secret) {
    const digest = crypto_1.default.createHmac('sha256', secret).update(message).digest();
    const signatureBuffer = Buffer.from(signature, isHex(signature) ? 'hex' : 'base64');
    if (signatureBuffer.length !== digest.length) {
        return false;
    }
    return crypto_1.default.timingSafeEqual(digest, signatureBuffer);
}
function verifyTelnyxSignature({ rawBody, signature, timestamp, scheme, }) {
    if (env_1.env.TELNYX_SKIP_SIGNATURE) {
        return { ok: true, skipped: true };
    }
    if (!signature || !timestamp) {
        return { ok: false, skipped: false };
    }
    const parsedTimestamp = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(parsedTimestamp)) {
        return { ok: false, skipped: false };
    }
    const now = Math.floor(Date.now() / 1000);
    const normalizedTimestamp = parsedTimestamp > 1000000000000 ? Math.floor(parsedTimestamp / 1000) : parsedTimestamp;
    if (Math.abs(now - normalizedTimestamp) > MAX_SKEW_SECONDS) {
        return { ok: false, skipped: false };
    }
    const message = Buffer.concat([
        Buffer.from(timestamp, 'utf8'),
        Buffer.from('.', 'utf8'),
        rawBody,
    ]);
    const secret = process.env.TELNYX_WEBHOOK_SECRET;
    const shouldUseHmac = scheme === 'hmac-sha256' || (!!secret && scheme !== 'ed25519');
    try {
        if (shouldUseHmac && secret) {
            return { ok: verifyHmacSignature(message, signature, secret), skipped: false };
        }
        const publicKey = parsePublicKey(env_1.env.TELNYX_PUBLIC_KEY);
        const signatureBuffer = Buffer.from(signature, isHex(signature) ? 'hex' : 'base64');
        return { ok: crypto_1.default.verify(null, message, publicKey, signatureBuffer), skipped: false };
    }
    catch {
        return { ok: false, skipped: false };
    }
}
//# sourceMappingURL=telnyxVerify.js.map