import { Request, Router } from 'express';
import { SessionManager } from '../calls/sessionManager';
import { tryAcquire } from '../limits/capacity';
import { log } from '../log';
import { storeWav } from '../storage/audioStore';
import { resolveTenantId } from '../tenants/tenantResolver';
import { TelnyxClient } from '../telnyx/telnyxClient';
import {
  extractTelnyxEventMetaFromPayload,
  extractTelnyxEventMetaFromRawBody,
  verifyTelnyxSignature,
} from '../telnyx/telnyxVerify';
import { TelnyxWebhookPayload } from '../telnyx/types';
import { synthesizeSpeech } from '../tts/kokoroTTS';

type RequestWithRawBody = Request & { rawBody?: Buffer; id?: string };

export function createTelnyxWebhookRouter(sessionManager: SessionManager): Router {
  const router = Router();

  function determineAction(eventType?: string, callControlId?: string): string {
    if (!eventType) {
      return 'ignored_unknown_event';
    }

    if (!callControlId) {
      return 'ignored_missing_call_control_id';
    }

    switch (eventType) {
      case 'call.initiated':
        return 'session_created';
      case 'call.answered':
        return 'session_answered';
      case 'call.hangup':
      case 'call.ended':
        return 'session_torn_down';
      default:
        return 'ignored_unhandled_event';
    }
  }

  function getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }

  function getToNumber(payload?: Record<string, unknown>): string | undefined {
    if (!payload) {
      return undefined;
    }

    const raw = payload.to;
    if (typeof raw === 'string') {
      return getString(raw);
    }

    if (raw && typeof raw === 'object') {
      const phoneNumber = (raw as { phone_number?: unknown }).phone_number;
      if (typeof phoneNumber === 'string') {
        return getString(phoneNumber);
      }
    }

    return undefined;
  }

  async function playMessageAndHangup(options: {
    callControlId: string;
    message: string;
    reason: string;
    requestId?: string;
    tenantId?: string;
  }): Promise<void> {
    const context = {
      call_control_id: options.callControlId,
      tenant_id: options.tenantId,
      requestId: options.requestId,
    };
    const telnyx = new TelnyxClient(context);

    try {
      await telnyx.answerCall(options.callControlId);

      const ttsStart = Date.now();
      const ttsResult = await synthesizeSpeech({ text: options.message });
      const ttsDuration = Date.now() - ttsStart;
      log.info(
        {
          event: 'tts_synthesized',
          duration_ms: ttsDuration,
          audio_bytes: ttsResult.audio.length,
          ...context,
        },
        'tts synthesized',
      );

      const publicUrl = await storeWav(options.callControlId, options.reason, ttsResult.audio);
      const playbackStart = Date.now();
      await telnyx.playAudio(options.callControlId, publicUrl);
      const playbackDuration = Date.now() - playbackStart;
      log.info(
        {
          event: 'telnyx_playback_duration',
          duration_ms: playbackDuration,
          audio_url: publicUrl,
          ...context,
        },
        'telnyx playback completed',
      );
    } catch (error) {
      log.warn({ err: error, ...context }, 'failed to play decline message');
    } finally {
      try {
        await telnyx.hangupCall(options.callControlId);
      } catch (error) {
        log.error({ err: error, ...context }, 'failed to hangup call');
      }
    }
  }

  async function enqueueSessionWork(
    eventType?: string,
    callControlId?: string,
    payload?: Record<string, unknown>,
    requestId?: string,
    fallbackTenantId?: string,
  ): Promise<void> {
    if (!eventType || !callControlId) {
      return;
    }

    try {
      switch (eventType) {
        case 'call.initiated': {
          const toNumber = getToNumber(payload);
          const tenantId = toNumber ? await resolveTenantId(toNumber) : null;
          if (!tenantId) {
            await playMessageAndHangup({
              callControlId,
              message: 'The number you dialed is not configured.',
              reason: 'number_not_configured',
              requestId,
            });
            return;
          }

          let capacity;
          try {
            capacity = await tryAcquire({
              tenantId,
              callControlId,
              requestId,
            });
          } catch (error) {
            log.error(
              { err: error, call_control_id: callControlId, tenant_id: tenantId, requestId },
              'capacity check failed',
            );
            await playMessageAndHangup({
              callControlId,
              message: 'We are unable to accept your call right now.',
              reason: 'capacity_error',
              requestId,
              tenantId,
            });
            return;
          }

          if (!capacity.ok) {
            await playMessageAndHangup({
              callControlId,
              message: 'We are currently at capacity. Please try again later.',
              reason: 'at_capacity',
              requestId,
              tenantId,
            });
            return;
          }

          sessionManager.createSession(
            {
              callControlId,
              tenantId,
              from: getString(payload?.from),
              to: toNumber,
            },
            { requestId },
          );
          break;
        }
        case 'call.answered':
          sessionManager.onAnswered(callControlId, { requestId });
          break;
        case 'call.hangup':
        case 'call.ended':
          sessionManager.onHangup(callControlId, eventType, {
            requestId,
            tenantId: fallbackTenantId,
          });
          break;
        default:
          break;
      }
    } catch (error) {
      log.error(
        { err: error, event_type: eventType, call_control_id: callControlId },
        'webhook dispatch failed',
      );
    }
  }

  router.post('/', (req, res) => {
    const request = req as RequestWithRawBody;
    const requestId = request.id;
    const rawBody = request.rawBody ?? Buffer.from('');
    const signatureEd25519 = req.header('telnyx-signature-ed25519');
    const signatureHmac = req.header('telnyx-signature');
    const signature = signatureEd25519 ?? signatureHmac ?? '';
    const timestamp = req.header('telnyx-timestamp') ?? '';
    const scheme = signatureEd25519 ? 'ed25519' : signatureHmac ? 'hmac-sha256' : undefined;

    const rawMeta = extractTelnyxEventMetaFromRawBody(rawBody);
    const isValid = verifyTelnyxSignature({ rawBody, signature, timestamp, scheme });

    if (!isValid) {
      log.warn(
        {
          requestId,
          event_type: rawMeta.eventType,
          call_control_id: rawMeta.callControlId,
          tenant_id: rawMeta.tenantId,
          action_taken: 'reject_invalid_signature',
        },
        'telnyx webhook ack',
      );
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const payload =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as TelnyxWebhookPayload)
        : undefined;
    const parsedMeta = extractTelnyxEventMetaFromPayload(payload ?? req.body);
    const eventType = parsedMeta.eventType ?? rawMeta.eventType;
    const callControlId = parsedMeta.callControlId ?? rawMeta.callControlId;
    const tenantId = parsedMeta.tenantId ?? rawMeta.tenantId;
    const payloadObj =
      payload?.data?.payload && typeof payload.data.payload === 'object'
        ? (payload.data.payload as Record<string, unknown>)
        : undefined;

    const actionTaken = determineAction(eventType, callControlId);
    if (callControlId) {
      sessionManager.enqueue(callControlId, async () => {
        await enqueueSessionWork(eventType, callControlId, payloadObj, requestId, tenantId);
      });
    }

    log.info(
      {
        requestId,
        event_type: eventType,
        call_control_id: callControlId,
        tenant_id: tenantId,
        action_taken: actionTaken,
      },
      'telnyx webhook ack',
    );

    res.status(200).json({ ok: true });
  });

  return router;
}
