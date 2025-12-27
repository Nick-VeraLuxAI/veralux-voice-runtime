import { Request, Router } from 'express';
import { SessionManager } from '../calls/sessionManager';
import { env } from '../env';
import { tryAcquire } from '../limits/capacity';
import { log } from '../log';
import { storeWav } from '../storage/audioStore';
import { normalizeE164, resolveTenantId } from '../tenants/tenantResolver';
import { loadTenantConfig } from '../tenants/tenantConfig';
import { TelnyxClient } from '../telnyx/telnyxClient';
import {
  extractTelnyxEventMetaFromPayload,
  extractTelnyxEventMetaFromRawBody,
  verifyTelnyxSignature,
} from '../telnyx/telnyxVerify';
import { TelnyxWebhookPayload } from '../telnyx/types';
import { synthesizeSpeech } from '../tts/kokoroTTS';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';

type RequestWithRawBody = Request & { rawBody?: Buffer; id?: string };

export function createTelnyxWebhookRouter(sessionManager: SessionManager): Router {
  const router = Router();
  const streamingStarted = new Set<string>();
  const tenantDebugEnabled = (): boolean => {
    const value = process.env.TENANT_DEBUG;
    if (!value) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  };
  const mediaDebugEnabled = (): boolean => {
    const value = process.env.MEDIA_DEBUG;
    if (!value) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  };

  function buildMediaStreamUrl(callControlId: string): string {
    const trimmedBase = env.PUBLIC_BASE_URL.replace(/\/$/, '');
    let wsBase = trimmedBase;
    if (trimmedBase.startsWith('https://')) {
      wsBase = `wss://${trimmedBase.slice('https://'.length)}`;
    } else if (trimmedBase.startsWith('http://')) {
      wsBase = `ws://${trimmedBase.slice('http://'.length)}`;
    } else if (!trimmedBase.startsWith('ws://') && !trimmedBase.startsWith('wss://')) {
      wsBase = `wss://${trimmedBase}`;
    }
    return `${wsBase}/v1/telnyx/media/${callControlId}?token=${encodeURIComponent(
      env.MEDIA_STREAM_TOKEN,
    )}`;
  }

  async function startStreamingOnce(callControlId: string, tenantId?: string, requestId?: string): Promise<void> {
    if (streamingStarted.has(callControlId)) {
      return;
    }

    const streamUrl = buildMediaStreamUrl(callControlId);
    if (mediaDebugEnabled()) {
      log.info(
        { event: 'streaming_start_requested', call_control_id: callControlId, stream_url: streamUrl, requestId },
        'streaming start requested',
      );
    }

    const telnyx = new TelnyxClient({
      call_control_id: callControlId,
      tenant_id: tenantId,
      requestId,
    });
    if (shouldSkipTelnyxAction('streaming_start', callControlId, tenantId, requestId)) {
      return;
    }

    streamingStarted.add(callControlId);
    try {
      await telnyx.startStreaming(callControlId, streamUrl);
    } catch (error) {
      streamingStarted.delete(callControlId);
      throw error;
    }
  }

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
      case 'call.playback.started':
        return 'playback_started';
      case 'call.playback.ended':
        return 'playback_ended';
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
    ttsConfig?: RuntimeTenantConfig['tts'];
  }): Promise<void> {
    const context = {
      call_control_id: options.callControlId,
      tenant_id: options.tenantId,
      requestId: options.requestId,
    };
    const telnyx = new TelnyxClient(context);

    try {
      if (shouldSkipTelnyxAction('answer', options.callControlId, options.tenantId, options.requestId)) {
        return;
      }
      await telnyx.answerCall(options.callControlId);

      const ttsStart = Date.now();
      const ttsResult = await synthesizeSpeech({
        text: options.message,
        voice: options.ttsConfig?.voice,
        format: options.ttsConfig?.format,
        sampleRate: options.ttsConfig?.sampleRate,
        kokoroUrl: options.ttsConfig?.kokoroUrl,
      });
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
      if (shouldSkipTelnyxAction('playback_start', options.callControlId, options.tenantId, options.requestId)) {
        return;
      }
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
        if (!shouldSkipTelnyxAction('hangup', options.callControlId, options.tenantId, options.requestId)) {
          await telnyx.hangupCall(options.callControlId);
        }
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
    payloadEnvelope?: TelnyxWebhookPayload | Record<string, unknown>,
  ): Promise<void> {
    if (!eventType || !callControlId) {
      return;
    }

    try {
      switch (eventType) {
        case 'call.initiated': {
          const debugEnabled = tenantDebugEnabled();
          const envelope =
            payloadEnvelope && typeof payloadEnvelope === 'object' ? payloadEnvelope : undefined;
          const envelopeData =
            envelope && typeof (envelope as { data?: unknown }).data === 'object'
              ? (envelope as { data?: Record<string, unknown> }).data
              : undefined;
          const envelopePayload =
            envelopeData && typeof (envelopeData as { payload?: unknown }).payload === 'object'
              ? (envelopeData as { payload?: Record<string, unknown> }).payload
              : undefined;
          const didPayload = payload ?? envelopePayload;

          if (debugEnabled) {
            log.info(
              {
                event: 'tenant_did_debug',
                call_control_id: callControlId,
                requestId,
                to: (payload as { to?: unknown } | undefined)?.to ?? (envelopePayload as { to?: unknown } | undefined)?.to,
                from:
                  (payload as { from?: unknown } | undefined)?.from ??
                  (envelopePayload as { from?: unknown } | undefined)?.from,
                dataTo:
                  (envelopeData as { to?: unknown } | undefined)?.to ??
                  (envelopePayload as { to?: unknown } | undefined)?.to,
                dataFrom:
                  (envelopeData as { from?: unknown } | undefined)?.from ??
                  (envelopePayload as { from?: unknown } | undefined)?.from,
                payloadTo:
                  (payload as { to?: unknown } | undefined)?.to ??
                  (envelopePayload as { to?: unknown } | undefined)?.to,
                payloadFrom:
                  (payload as { from?: unknown } | undefined)?.from ??
                  (envelopePayload as { from?: unknown } | undefined)?.from,
                destination:
                  (payload as { destination?: unknown } | undefined)?.destination ??
                  (envelopePayload as { destination?: unknown } | undefined)?.destination,
                to_number:
                  (payload as { to_number?: unknown } | undefined)?.to_number ??
                  (envelopePayload as { to_number?: unknown } | undefined)?.to_number,
                called_number:
                  (payload as { called_number?: unknown } | undefined)?.called_number ??
                  (envelopePayload as { called_number?: unknown } | undefined)?.called_number,
              },
              'tenant did debug',
            );
          }

          const toNumber = getToNumber(didPayload);
          const normalizedTo = toNumber ? normalizeE164(toNumber) : '';
          const redisKey = normalizedTo ? `${env.TENANTMAP_PREFIX}:did:${normalizedTo}` : '';

          if (debugEnabled) {
            log.info(
              {
                event: 'tenant_resolve_input',
                call_control_id: callControlId,
                requestId,
                rawTo: toNumber,
                normalizedTo,
                redisKey,
              },
              'tenant resolve input',
            );
          }

          const tenantId = toNumber ? await resolveTenantId(toNumber) : null;
          if (debugEnabled) {
            log.info(
              { event: 'tenant_resolve_result', call_control_id: callControlId, requestId, tenant_id: tenantId },
              'tenant resolve result',
            );
          }
          if (!tenantId) {
            await playMessageAndHangup({
              callControlId,
              message: 'The number you dialed is not configured.',
              reason: 'number_not_configured',
              requestId,
            });
            return;
          }

          const tenantConfig = await loadTenantConfig(tenantId);
          if (!tenantConfig) {
            log.warn(
              { tenant_id: tenantId, call_control_id: callControlId, requestId },
              'tenant config missing or invalid',
            );
            await playMessageAndHangup({
              callControlId,
              message: 'This number is not fully configured.',
              reason: 'tenant_config_missing',
              requestId,
              tenantId,
            });
            return;
          }

          let capacity;
          try {
            capacity = await tryAcquire({
              tenantId,
              callControlId,
              requestId,
              capDefaults: {
                tenantConcurrency: tenantConfig.caps.maxConcurrentCallsTenant,
                tenantRpm: tenantConfig.caps.maxCallsPerMinuteTenant,
                globalConcurrency: tenantConfig.caps.maxConcurrentCallsGlobal,
              },
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
              ttsConfig: tenantConfig.tts,
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
              ttsConfig: tenantConfig.tts,
            });
            return;
          }

          sessionManager.createSession(
            {
              callControlId,
              tenantId,
              from: getString(payload?.from),
              to: toNumber,
              tenantConfig,
            },
            { requestId },
          );
          break;
        }
        case 'call.playback.started': {
          if (mediaDebugEnabled()) {
            log.info(
              { event: 'playback_started', call_control_id: callControlId, requestId },
              'playback started',
            );
          }
          break;
        }
        case 'call.playback.ended': {
          const debugEnabled = mediaDebugEnabled();
          if (debugEnabled) {
            log.info(
              { event: 'playback_ended', call_control_id: callControlId, requestId },
              'playback ended',
            );
          }

          sessionManager.onPlaybackEnded(callControlId, { requestId });

          if (!streamingStarted.has(callControlId)) {
            if (debugEnabled) {
              log.info(
                { event: 'listen_start', call_control_id: callControlId, tenant_id: fallbackTenantId, requestId },
                'listen start',
              );
            }
            await startStreamingOnce(callControlId, fallbackTenantId, requestId);
          }
          break;
        }
        case 'call.answered':
          sessionManager.onAnswered(callControlId, { requestId });
          await startStreamingOnce(callControlId, fallbackTenantId, requestId);
          break;
        case 'call.hangup':
        case 'call.ended':
          sessionManager.onHangup(callControlId, eventType, {
            requestId,
            tenantId: fallbackTenantId,
          });
          streamingStarted.delete(callControlId);
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

  function shouldSkipTelnyxAction(
    action: string,
    callControlId: string,
    tenantId?: string,
    requestId?: string,
  ): boolean {
    if (sessionManager.isCallActive(callControlId)) {
      return false;
    }

    log.warn(
      {
        event: 'telnyx_action_skipped_inactive',
        action,
        call_control_id: callControlId,
        tenant_id: tenantId,
        requestId,
      },
      'skipping telnyx action - call inactive',
    );
    return true;
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
    const signatureCheck = verifyTelnyxSignature({ rawBody, signature, timestamp, scheme });

    if (signatureCheck.skipped) {
      log.warn({ requestId, event_type: rawMeta.eventType }, 'telnyx signature check skipped (dev)');
    }

    if (!signatureCheck.ok) {
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
      const requiresActive = eventType !== 'call.hangup' && eventType !== 'call.ended';
      const taskName = `telnyx_webhook_${eventType ?? 'unknown'}`;
      sessionManager.enqueue(callControlId, {
        name: taskName,
        requiresActive,
        run: async () => {
          await enqueueSessionWork(
            eventType,
            callControlId,
            payloadObj,
            requestId,
            tenantId,
            payload ?? req.body,
          );
        },
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
