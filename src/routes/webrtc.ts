import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { env } from '../env';
import { log } from '../log';
import { tryAcquire } from '../limits/capacity';
import { loadTenantConfig } from '../tenants/tenantConfig';
import { WebRtcHdTransportSession } from '../transport/webrtcHdTransport';
import { SessionManager } from '../calls/sessionManager';

interface OfferPayload {
  offer?: { type: 'offer'; sdp: string };
  tenant_id?: string;
  session_id?: string;
}

function parseAllowedOrigins(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') return null;
  return trimmed.split(',').map((value) => value.trim()).filter(Boolean);
}

function allowOrigin(req: Request, res: Response, allowed: string[] | null): boolean {
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

export function createWebRtcRouter(sessionManager: SessionManager): Router {
  const router = Router();
  const allowedOrigins = parseAllowedOrigins(env.WEBRTC_ALLOWED_ORIGINS);

  router.options('/offer', (req, res) => {
    if (!allowOrigin(req, res, allowedOrigins)) {
      res.status(403).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.status(204).end();
  });

  router.post('/offer', async (req: Request, res: Response) => {
    if (env.TRANSPORT_MODE !== 'webrtc_hd') {
      res.status(403).json({ error: 'webrtc_disabled' });
      return;
    }
    if (!allowOrigin(req, res, allowedOrigins)) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }

    const body = req.body as OfferPayload;
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

    const requestId = (req as { id?: string }).id;
    const sessionId = body.session_id ?? randomUUID();

    const tenantConfig = await loadTenantConfig(tenantId);
    if (!tenantConfig) {
      res.status(404).json({ error: 'tenant_config_missing' });
      return;
    }

    let capacity;
    try {
      capacity = await tryAcquire({
        tenantId,
        callControlId: sessionId,
        requestId,
        capDefaults: {
          tenantConcurrency: tenantConfig.caps.maxConcurrentCallsTenant,
          tenantRpm: tenantConfig.caps.maxCallsPerMinuteTenant,
          globalConcurrency: tenantConfig.caps.maxConcurrentCallsGlobal,
        },
      });
    } catch (error) {
      log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc capacity check failed');
      res.status(500).json({ error: 'capacity_error' });
      return;
    }

    if (!capacity.ok) {
      res.status(429).json({ error: 'at_capacity' });
      return;
    }

    let transport: WebRtcHdTransportSession;
    try {
      transport = new WebRtcHdTransportSession({
        sessionId,
        tenantId,
        requestId,
        onSessionEnded: (reason) => {
          sessionManager.onHangup(sessionId, reason, { tenantId, requestId });
        },
      });
    } catch (error) {
      log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc transport init failed');
      res.status(500).json({ error: 'webrtc_init_failed' });
      return;
    }

    let answer;
    try {
      answer = await transport.acceptOffer(offer);
    } catch (error) {
      log.error({ err: error, session_id: sessionId, tenant_id: tenantId, requestId }, 'webrtc offer failed');
      res.status(500).json({ error: 'webrtc_offer_failed' });
      return;
    }

    sessionManager.createSession(
      {
        callControlId: sessionId,
        tenantId,
        tenantConfig,
        transportSession: transport,
      },
      { requestId, tenantId },
      { autoAnswer: true },
    );

    res.status(200).json({ session_id: sessionId, answer });
  });

  return router;
}