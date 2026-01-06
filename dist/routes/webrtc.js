"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebRtcRouter = createWebRtcRouter;
const crypto_1 = require("crypto");
const express_1 = require("express");
const env_1 = require("../env");
const log_1 = require("../log");
const capacity_1 = require("../limits/capacity");
const tenantConfig_1 = require("../tenants/tenantConfig");
const webrtcHdTransport_1 = require("../transport/webrtcHdTransport");
function parseAllowedOrigins(raw) {
    if (!raw)
        return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '*')
        return null;
    return trimmed.split(',').map((value) => value.trim()).filter(Boolean);
}
function allowOrigin(req, res, allowed) {
    const origin = req.headers.origin;
    if (!origin) {
        return true;
    }
    if (!allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        return true;
    }
    const ok = allowed.includes(origin);
    if (ok) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    return ok;
}
function createWebRtcRouter(sessionManager) {
    const router = (0, express_1.Router)();
    const allowedOrigins = parseAllowedOrigins(env_1.env.WEBRTC_ALLOWED_ORIGINS);
    router.options('/offer', (req, res) => {
        if (!allowOrigin(req, res, allowedOrigins)) {
            res.status(403).end();
            return;
        }
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.status(204).end();
    });
    router.post('/offer', async (req, res) => {
        if (env_1.env.TRANSPORT_MODE !== 'webrtc_hd') {
            res.status(403).json({ error: 'webrtc_disabled' });
            return;
        }
        if (!allowOrigin(req, res, allowedOrigins)) {
            res.status(403).json({ error: 'origin_not_allowed' });
            return;
        }
        const body = req.body;
        const offer = body.offer;
        if (!offer || offer.type !== 'offer' || !offer.sdp) {
            res.status(400).json({ error: 'invalid_offer' });
            return;
        }
        const tenantId = body.tenant_id;
        if (!tenantId) {
            res.status(400).json({ error: 'tenant_id_required' });
            return;
        }
        const requestId = req.id;
        const sessionId = body.session_id ?? (0, crypto_1.randomUUID)();
        const tenantConfig = await (0, tenantConfig_1.loadTenantConfig)(tenantId);
        if (!tenantConfig) {
            res.status(404).json({ error: 'tenant_config_missing' });
            return;
        }
        let capacity;
        try {
            capacity = await (0, capacity_1.tryAcquire)({
                tenantId,
                callControlId: sessionId,
                requestId,
                capDefaults: {
                    tenantConcurrency: tenantConfig.caps.maxConcurrentCallsTenant,
                    tenantRpm: tenantConfig.caps.maxCallsPerMinuteTenant,
                    globalConcurrency: tenantConfig.caps.maxConcurrentCallsGlobal,
                },
            });
        }
        catch (error) {
            log_1.log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc capacity check failed');
            res.status(500).json({ error: 'capacity_error' });
            return;
        }
        if (!capacity.ok) {
            res.status(429).json({ error: 'at_capacity' });
            return;
        }
        let transport;
        try {
            transport = new webrtcHdTransport_1.WebRtcHdTransportSession({
                sessionId,
                tenantId,
                requestId,
                onSessionEnded: (reason) => {
                    sessionManager.onHangup(sessionId, reason, { tenantId, requestId });
                },
            });
        }
        catch (error) {
            log_1.log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc transport init failed');
            res.status(500).json({ error: 'webrtc_init_failed' });
            return;
        }
        let answer;
        try {
            answer = await transport.acceptOffer(offer);
        }
        catch (error) {
            log_1.log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc offer failed');
            res.status(500).json({ error: 'webrtc_offer_failed' });
            return;
        }
        sessionManager.createSession({
            callControlId: sessionId,
            tenantId,
            tenantConfig,
            transportSession: transport,
        }, { requestId, tenantId }, { autoAnswer: true });
        res.status(200).json({ session_id: sessionId, answer });
    });
    return router;
}
//# sourceMappingURL=webrtc.js.map