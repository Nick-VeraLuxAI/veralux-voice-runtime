"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelnyxWebhookRouter = createTelnyxWebhookRouter;
const express_1 = require("express");
const env_1 = require("../env");
const capacity_1 = require("../limits/capacity");
const log_1 = require("../log");
const wavInfo_1 = require("../audio/wavInfo");
const playbackPipeline_1 = require("../audio/playbackPipeline");
const audioProbe_1 = require("../diagnostics/audioProbe");
const metrics_1 = require("../metrics");
const audioStore_1 = require("../storage/audioStore");
const tenantResolver_1 = require("../tenants/tenantResolver");
const tenantConfig_1 = require("../tenants/tenantConfig");
const telnyxClient_1 = require("../telnyx/telnyxClient");
const telnyxVerify_1 = require("../telnyx/telnyxVerify");
const kokoroTTS_1 = require("../tts/kokoroTTS");
function logTtsBytesReady(context, id, audio, contentType) {
    const header = (0, wavInfo_1.describeWavHeader)(audio);
    log_1.log.info({
        event: 'tts_bytes_ready',
        id,
        bytes: audio.length,
        riff: header.riff,
        wave: header.wave,
        ...context,
    }, 'tts bytes ready');
    if (!header.riff || !header.wave) {
        log_1.log.warn({
            event: 'tts_non_wav_warning',
            id,
            content_type: contentType,
            first16_hex: header.first16Hex,
            bytes: audio.length,
            ...context,
        }, 'tts bytes are not wav');
    }
    const audioLogContext = { ...context, tts_id: id };
    const baseMeta = {
        callId: typeof context.call_control_id === 'string' ? context.call_control_id : undefined,
        tenantId: typeof context.tenant_id === 'string' ? context.tenant_id : undefined,
        format: 'wav',
        logContext: audioLogContext,
        lineage: ['tts:output'],
        kind: id,
    };
    (0, audioProbe_1.attachAudioMeta)(audio, baseMeta);
    (0, audioProbe_1.probeWav)('tts.out.raw', audio, baseMeta);
    try {
        const info = (0, wavInfo_1.parseWavInfo)(audio);
        log_1.log.info({
            event: 'wav_info',
            source: 'kokoro',
            id,
            sample_rate_hz: info.sampleRateHz,
            channels: info.channels,
            bits_per_sample: info.bitsPerSample,
            data_bytes: info.dataBytes,
            duration_ms: info.durationMs,
            ...context,
        }, 'wav info');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown_error';
        log_1.log.warn({
            event: 'wav_info_parse_failed',
            source: 'kokoro',
            id,
            reason,
            ...context,
        }, 'wav info parse failed');
    }
}
function createTelnyxWebhookRouter(sessionManager) {
    const router = (0, express_1.Router)();
    const streamingStarted = new Set();
    const tenantDebugEnabled = () => {
        const value = process.env.TENANT_DEBUG;
        if (!value) {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    };
    const mediaDebugEnabled = () => {
        const value = process.env.MEDIA_DEBUG;
        if (!value) {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    };
    function buildMediaStreamUrl(callControlId) {
        const trimmedBase = env_1.env.PUBLIC_BASE_URL.replace(/\/$/, '');
        let wsBase = trimmedBase;
        if (trimmedBase.startsWith('https://')) {
            wsBase = `wss://${trimmedBase.slice('https://'.length)}`;
        }
        else if (trimmedBase.startsWith('http://')) {
            wsBase = `ws://${trimmedBase.slice('http://'.length)}`;
        }
        else if (!trimmedBase.startsWith('ws://') && !trimmedBase.startsWith('wss://')) {
            wsBase = `wss://${trimmedBase}`;
        }
        return `${wsBase}/v1/telnyx/media/${callControlId}?token=${encodeURIComponent(env_1.env.MEDIA_STREAM_TOKEN)}`;
    }
    async function startStreamingOnce(callControlId, tenantId, requestId) {
        if (streamingStarted.has(callControlId)) {
            return;
        }
        const streamUrl = buildMediaStreamUrl(callControlId);
        if (mediaDebugEnabled()) {
            log_1.log.info({ event: 'streaming_start_requested', call_control_id: callControlId, stream_url: streamUrl, requestId }, 'streaming start requested');
        }
        const telnyx = new telnyxClient_1.TelnyxClient({
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
        }
        catch (error) {
            streamingStarted.delete(callControlId);
            throw error;
        }
    }
    function determineAction(eventType, callControlId) {
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
            case 'streaming.stopped':
                return 'streaming_stopped';
            case 'call.hangup':
            case 'call.ended':
                return 'session_torn_down';
            default:
                return 'ignored_unhandled_event';
        }
    }
    function getString(value) {
        return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    }
    function getToNumber(payload) {
        if (!payload) {
            return undefined;
        }
        const raw = payload.to;
        if (typeof raw === 'string') {
            return getString(raw);
        }
        if (raw && typeof raw === 'object') {
            const phoneNumber = raw.phone_number;
            if (typeof phoneNumber === 'string') {
                return getString(phoneNumber);
            }
        }
        return undefined;
    }
    async function playMessageAndHangup(options) {
        const context = {
            call_control_id: options.callControlId,
            tenant_id: options.tenantId,
            requestId: options.requestId,
        };
        const telnyx = new telnyxClient_1.TelnyxClient(context);
        try {
            if (shouldSkipTelnyxAction('answer', options.callControlId, options.tenantId, options.requestId)) {
                return;
            }
            await telnyx.answerCall(options.callControlId);
            const ttsStart = Date.now();
            const ttsResult = await (0, kokoroTTS_1.synthesizeSpeech)({
                text: options.message,
                voice: options.ttsConfig?.voice,
                format: options.ttsConfig?.format,
                sampleRate: options.ttsConfig?.sampleRate,
                kokoroUrl: options.ttsConfig?.kokoroUrl,
            });
            const ttsDuration = Date.now() - ttsStart;
            log_1.log.info({
                event: 'tts_synthesized',
                duration_ms: ttsDuration,
                audio_bytes: ttsResult.audio.length,
                ...context,
            }, 'tts synthesized');
            logTtsBytesReady(context, options.reason, ttsResult.audio, ttsResult.contentType);
            const pipelineApplied = env_1.env.PLAYBACK_PROFILE === 'pstn';
            if (pipelineApplied) {
                const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', options.tenantId ?? 'unknown');
                const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(ttsResult.audio, {
                    targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                    enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                    logContext: context,
                });
                endPipeline();
                ttsResult.audio = pipelineResult.audio;
            }
            const pipelineMeta = (0, audioProbe_1.getAudioMeta)(ttsResult.audio) ?? {
                format: 'wav',
                logContext: context,
                lineage: ['pipeline:unknown'],
            };
            if (pipelineApplied) {
                (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', ttsResult.audio, pipelineMeta);
            }
            (0, audioProbe_1.probeWav)('tx.telnyx.payload', ttsResult.audio, {
                ...pipelineMeta,
                kind: options.reason,
            });
            try {
                const info = (0, wavInfo_1.parseWavInfo)(ttsResult.audio);
                log_1.log.info({
                    event: 'wav_info',
                    source: 'pipeline_output',
                    id: options.reason,
                    sample_rate_hz: info.sampleRateHz,
                    channels: info.channels,
                    bits_per_sample: info.bitsPerSample,
                    data_bytes: info.dataBytes,
                    duration_ms: info.durationMs,
                    ...context,
                }, 'wav info');
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : 'unknown_error';
                log_1.log.warn({
                    event: 'wav_info_parse_failed',
                    source: 'pipeline_output',
                    id: options.reason,
                    reason,
                    ...context,
                }, 'wav info parse failed');
            }
            const publicUrl = await (0, audioStore_1.storeWav)(options.callControlId, options.reason, ttsResult.audio);
            const playbackStart = Date.now();
            if (shouldSkipTelnyxAction('playback_start', options.callControlId, options.tenantId, options.requestId)) {
                return;
            }
            await telnyx.playAudio(options.callControlId, publicUrl);
            const playbackDuration = Date.now() - playbackStart;
            log_1.log.info({
                event: 'telnyx_playback_duration',
                duration_ms: playbackDuration,
                audio_url: publicUrl,
                ...context,
            }, 'telnyx playback completed');
        }
        catch (error) {
            log_1.log.warn({ err: error, ...context }, 'failed to play decline message');
        }
        finally {
            try {
                if (!shouldSkipTelnyxAction('hangup', options.callControlId, options.tenantId, options.requestId)) {
                    log_1.log.info({ event: 'telnyx_hangup_requested', reason: options.reason, ...context }, 'telnyx hangup requested (playMessageAndHangup)');
                    await telnyx.hangupCall(options.callControlId);
                }
            }
            catch (error) {
                log_1.log.error({ err: error, ...context }, 'failed to hangup call');
            }
        }
    }
    async function enqueueSessionWork(eventType, callControlId, payload, requestId, fallbackTenantId, payloadEnvelope) {
        if (!eventType || !callControlId) {
            return;
        }
        try {
            switch (eventType) {
                case 'call.initiated': {
                    const debugEnabled = tenantDebugEnabled();
                    const envelope = payloadEnvelope && typeof payloadEnvelope === 'object' ? payloadEnvelope : undefined;
                    const envelopeData = envelope && typeof envelope.data === 'object'
                        ? envelope.data
                        : undefined;
                    const envelopePayload = envelopeData && typeof envelopeData.payload === 'object'
                        ? envelopeData.payload
                        : undefined;
                    const didPayload = payload ?? envelopePayload;
                    if (debugEnabled) {
                        log_1.log.info({
                            event: 'tenant_did_debug',
                            call_control_id: callControlId,
                            requestId,
                            to: payload?.to ?? envelopePayload?.to,
                            from: payload?.from ??
                                envelopePayload?.from,
                            dataTo: envelopeData?.to ??
                                envelopePayload?.to,
                            dataFrom: envelopeData?.from ??
                                envelopePayload?.from,
                            payloadTo: payload?.to ??
                                envelopePayload?.to,
                            payloadFrom: payload?.from ??
                                envelopePayload?.from,
                            destination: payload?.destination ??
                                envelopePayload?.destination,
                            to_number: payload?.to_number ??
                                envelopePayload?.to_number,
                            called_number: payload?.called_number ??
                                envelopePayload?.called_number,
                        }, 'tenant did debug');
                    }
                    const toNumber = getToNumber(didPayload);
                    const normalizedTo = toNumber ? (0, tenantResolver_1.normalizeE164)(toNumber) : '';
                    const redisKey = normalizedTo ? `${env_1.env.TENANTMAP_PREFIX}:did:${normalizedTo}` : '';
                    if (debugEnabled) {
                        log_1.log.info({
                            event: 'tenant_resolve_input',
                            call_control_id: callControlId,
                            requestId,
                            rawTo: toNumber,
                            normalizedTo,
                            redisKey,
                        }, 'tenant resolve input');
                    }
                    const tenantId = toNumber ? await (0, tenantResolver_1.resolveTenantId)(toNumber) : null;
                    if (debugEnabled) {
                        log_1.log.info({ event: 'tenant_resolve_result', call_control_id: callControlId, requestId, tenant_id: tenantId }, 'tenant resolve result');
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
                    const tenantConfig = await (0, tenantConfig_1.loadTenantConfig)(tenantId);
                    if (!tenantConfig) {
                        log_1.log.warn({ tenant_id: tenantId, call_control_id: callControlId, requestId }, 'tenant config missing or invalid');
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
                        capacity = await (0, capacity_1.tryAcquire)({
                            tenantId,
                            callControlId,
                            requestId,
                            capDefaults: {
                                tenantConcurrency: tenantConfig.caps.maxConcurrentCallsTenant,
                                tenantRpm: tenantConfig.caps.maxCallsPerMinuteTenant,
                                globalConcurrency: tenantConfig.caps.maxConcurrentCallsGlobal,
                            },
                        });
                    }
                    catch (error) {
                        log_1.log.error({ err: error, call_control_id: callControlId, tenant_id: tenantId, requestId }, 'capacity check failed');
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
                    sessionManager.createSession({
                        callControlId,
                        tenantId,
                        from: getString(payload?.from),
                        to: toNumber,
                        tenantConfig,
                    }, { requestId });
                    break;
                }
                case 'call.answered': {
                    const debugEnabled = mediaDebugEnabled();
                    sessionManager.onAnswered(callControlId, { requestId });
                    if (!streamingStarted.has(callControlId)) {
                        if (debugEnabled) {
                            log_1.log.info({
                                event: 'listen_start',
                                reason: 'call_answered',
                                call_control_id: callControlId,
                                tenant_id: fallbackTenantId,
                                requestId,
                            }, 'listen start');
                        }
                        await startStreamingOnce(callControlId, fallbackTenantId, requestId);
                    }
                    break;
                }
                case 'call.playback.started': {
                    if (mediaDebugEnabled()) {
                        log_1.log.info({ event: 'playback_started', call_control_id: callControlId, requestId }, 'playback started');
                    }
                    break;
                }
                case 'call.playback.ended': {
                    const debugEnabled = mediaDebugEnabled();
                    if (debugEnabled) {
                        log_1.log.info({ event: 'playback_ended', call_control_id: callControlId, requestId }, 'playback ended');
                    }
                    // ✅ FIX: this MUST call the PSTN-authoritative Telnyx handler
                    sessionManager.onTelnyxPlaybackEnded(callControlId, {
                        requestId,
                        source: 'telnyx_webhook',
                    });
                    if (!streamingStarted.has(callControlId)) {
                        if (debugEnabled) {
                            log_1.log.info({ event: 'listen_start', call_control_id: callControlId, tenant_id: fallbackTenantId, requestId }, 'listen start');
                        }
                        await startStreamingOnce(callControlId, fallbackTenantId, requestId);
                    }
                    break;
                }
                case 'streaming.stopped': {
                    log_1.log.warn({ event: 'streaming_stopped', call_control_id: callControlId, requestId, tenant_id: fallbackTenantId }, 'telnyx streaming stopped');
                    sessionManager.onMediaStreamingStopped(callControlId, { requestId, tenantId: fallbackTenantId });
                    streamingStarted.delete(callControlId);
                    break;
                }
                case 'call.hangup':
                case 'call.ended': {
                    const p = payload && typeof payload === 'object'
                        ? payload
                        : payloadEnvelope && typeof payloadEnvelope === 'object'
                            ? payloadEnvelope
                            : undefined;
                    // If the fields are nested (common with Telnyx envelopes), try to grab data.payload too.
                    const data = p?.data && typeof p.data === 'object' ? p.data : undefined;
                    const pp = data?.payload && typeof data.payload === 'object'
                        ? data.payload
                        : p;
                    log_1.log.warn({
                        event: 'telnyx_hangup_webhook',
                        call_control_id: callControlId,
                        event_type: eventType,
                        requestId,
                        tenant_id: fallbackTenantId,
                        hangup_cause: pp?.hangup_cause,
                        hangup_source: pp?.hangup_source,
                        sip_hangup_cause: pp?.sip_hangup_cause,
                        error_code: pp?.error_code,
                        error_detail: pp?.error_detail,
                    }, 'hangup received');
                    sessionManager.onHangup(callControlId, eventType, {
                        requestId,
                        tenantId: fallbackTenantId,
                    });
                    streamingStarted.delete(callControlId);
                    break;
                }
            }
        }
        catch (error) {
            log_1.log.error({ err: error, event_type: eventType, call_control_id: callControlId }, 'webhook dispatch failed');
        }
    }
    function shouldSkipTelnyxAction(action, callControlId, tenantId, requestId) {
        if (sessionManager.isCallActive(callControlId)) {
            return false;
        }
        log_1.log.warn({
            event: 'telnyx_action_skipped_inactive',
            action,
            call_control_id: callControlId,
            tenant_id: tenantId,
            requestId,
        }, 'skipping telnyx action - call inactive');
        return true;
    }
    router.post('/', (req, res) => {
        const request = req;
        const requestId = request.id;
        const rawBody = request.rawBody ?? Buffer.from('');
        const signatureEd25519 = req.header('telnyx-signature-ed25519');
        const signatureHmac = req.header('telnyx-signature');
        const signature = signatureEd25519 ?? signatureHmac ?? '';
        const timestamp = req.header('telnyx-timestamp') ?? '';
        const scheme = signatureEd25519 ? 'ed25519' : signatureHmac ? 'hmac-sha256' : undefined;
        const rawMeta = (0, telnyxVerify_1.extractTelnyxEventMetaFromRawBody)(rawBody);
        const signatureCheck = (0, telnyxVerify_1.verifyTelnyxSignature)({ rawBody, signature, timestamp, scheme });
        if (signatureCheck.skipped) {
            log_1.log.warn({ requestId, event_type: rawMeta.eventType }, 'telnyx signature check skipped (dev)');
        }
        if (!signatureCheck.ok) {
            log_1.log.warn({
                requestId,
                event_type: rawMeta.eventType,
                call_control_id: rawMeta.callControlId,
                tenant_id: rawMeta.tenantId,
                action_taken: 'reject_invalid_signature',
            }, 'telnyx webhook ack');
            res.status(401).json({ error: 'invalid_signature' });
            return;
        }
        const payload = typeof req.body === 'object' && req.body !== null
            ? req.body
            : undefined;
        const parsedMeta = (0, telnyxVerify_1.extractTelnyxEventMetaFromPayload)(payload ?? req.body);
        const eventType = parsedMeta.eventType ?? rawMeta.eventType;
        const callControlId = parsedMeta.callControlId ?? rawMeta.callControlId;
        const tenantId = parsedMeta.tenantId ?? rawMeta.tenantId;
        const payloadObj = payload?.data?.payload && typeof payload.data.payload === 'object'
            ? payload.data.payload
            : undefined;
        const actionTaken = determineAction(eventType, callControlId);
        if (callControlId) {
            const requiresActive = eventType !== 'call.hangup' && eventType !== 'call.ended';
            const taskName = `telnyx_webhook_${eventType ?? 'unknown'}`;
            sessionManager.enqueue(callControlId, {
                name: taskName,
                requiresActive,
                run: async () => {
                    await enqueueSessionWork(eventType, callControlId, payloadObj, requestId, tenantId, payload ?? req.body);
                },
            });
        }
        log_1.log.info({
            requestId,
            event_type: eventType,
            call_control_id: callControlId,
            tenant_id: tenantId,
            action_taken: actionTaken,
        }, 'telnyx webhook ack');
        res.status(200).json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=telnyxWebhook.js.map