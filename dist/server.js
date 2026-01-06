"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const env_1 = require("./env");
const sessionManager_1 = require("./calls/sessionManager");
const log_1 = require("./log");
const wavInfo_1 = require("./audio/wavInfo");
const playbackPipeline_1 = require("./audio/playbackPipeline");
const codecDecode_1 = require("./audio/codecDecode");
const audioProbe_1 = require("./diagnostics/audioProbe");
const health_1 = require("./routes/health");
const telnyxWebhook_1 = require("./routes/telnyxWebhook");
const webrtc_1 = require("./routes/webrtc");
const kokoroTTS_1 = require("./tts/kokoroTTS");
const metrics_1 = require("./metrics");
function requestIdMiddleware(req, res, next) {
    const incomingId = req.header('x-request-id');
    const requestId = incomingId && incomingId.trim() !== '' ? incomingId : (0, crypto_1.randomUUID)();
    res.setHeader('x-request-id', requestId);
    req.id = requestId;
    next();
}
function errorHandler(err, _req, res, _next) {
    log_1.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal_server_error' });
}
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown_error';
}
function normalizeCodec(value) {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!normalized)
        return 'PCMU';
    if (normalized === 'AMRWB' || normalized === 'AMR_WB')
        return 'AMR-WB';
    return normalized;
}
function mapCodecToFormat(codec) {
    switch (codec) {
        case 'PCMU':
            return 'pcmu';
        case 'PCMA':
            // PCMA is A-law.
            return 'alaw';
        case 'L16':
            return 'pcm16le';
        case 'OPUS':
            return 'opus';
        case 'AMR-WB':
            return 'amrwb';
        default:
            return undefined;
    }
}
function mapCodecToBitDepth(codec) {
    switch (codec) {
        case 'PCMU':
        case 'PCMA':
            return 8;
        case 'L16':
            return 16;
        default:
            return undefined;
    }
}
function shouldProbeRaw(codec) {
    return codec === 'PCMU' || codec === 'PCMA';
}
function buildProbeMeta(callControlId, connection) {
    const codec = normalizeCodec(connection.mediaEncoding);
    const format = mapCodecToFormat(codec);
    const bitDepth = mapCodecToBitDepth(codec);
    const sampleRateHz = connection.mediaSampleRate ??
        (codec === 'PCMU' || codec === 'PCMA' ? 8000 : codec === 'AMR-WB' ? 16000 : undefined);
    const channels = connection.mediaChannels ?? 1;
    return {
        callId: callControlId,
        format,
        codec,
        sampleRateHz,
        channels,
        bitDepth,
        logContext: { call_control_id: callControlId },
        lineage: ['rx.telnyx.raw'],
    };
}
function resolveAudioFilePath(requestPath) {
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    let decoded;
    try {
        decoded = decodeURIComponent(safePath);
    }
    catch {
        return null;
    }
    const id = path_1.default.basename(decoded);
    if (!id || id === '/' || id === '.' || id === '..') {
        return null;
    }
    const baseDir = path_1.default.resolve(env_1.env.AUDIO_STORAGE_DIR);
    const resolvedPath = path_1.default.resolve(baseDir, `.${decoded}`);
    if (!resolvedPath.startsWith(`${baseDir}${path_1.default.sep}`) && resolvedPath !== baseDir) {
        return null;
    }
    return { id, filePath: resolvedPath };
}
function wavInfoLogger(route) {
    return (req, _res, next) => {
        const resolved = resolveAudioFilePath(req.path);
        if (!resolved) {
            next();
            return;
        }
        const { id, filePath } = resolved;
        void fs_1.default.promises
            .readFile(filePath)
            .then((buffer) => {
            const info = (0, wavInfo_1.parseWavInfo)(buffer);
            log_1.log.info({
                event: 'wav_info',
                source: 'audio_serve',
                route,
                id,
                sample_rate_hz: info.sampleRateHz,
                channels: info.channels,
                bits_per_sample: info.bitsPerSample,
                data_bytes: info.dataBytes,
                duration_ms: info.durationMs,
                file_path: filePath,
            }, 'wav info');
        })
            .catch((error) => {
            log_1.log.warn({
                event: 'wav_info_parse_failed',
                reason: getErrorMessage(error),
                source: 'audio_serve',
                route,
                id,
                file_path: filePath,
            }, 'wav info parse failed');
        });
        next();
    };
}
function playbackServeTimer() {
    return (_req, res, next) => {
        const end = (0, metrics_1.startStageTimer)('playback_serve_ms', undefined);
        res.on('finish', () => {
            end();
        });
        next();
    };
}
function logTtsBytesReady(id, audio, contentType, context) {
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
        log_1.log.warn({
            event: 'wav_info_parse_failed',
            source: 'kokoro',
            id,
            reason: getErrorMessage(error),
            ...context,
        }, 'wav info parse failed');
    }
}
const MEDIA_PATH_PREFIX = '/v1/telnyx/media/';
let unsupportedEncodingCount = 0;
const mediaDebugEnabled = () => {
    const value = process.env.MEDIA_DEBUG;
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};
function parseMediaRequest(request) {
    if (!request.url) {
        return null;
    }
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url, `http://${host}`);
    if (!url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
        return null;
    }
    const callControlId = url.pathname.slice(MEDIA_PATH_PREFIX.length);
    if (!callControlId || callControlId.includes('/')) {
        return null;
    }
    return {
        callControlId,
        token: url.searchParams.get('token'),
    };
}
function attachMediaWebSocketServer(server, sessionManager) {
    const wss = new ws_1.WebSocketServer({ noServer: true });
    const debugMedia = mediaDebugEnabled();
    const acceptCodecs = (0, codecDecode_1.parseTelnyxAcceptCodecs)(env_1.env.TELNYX_ACCEPT_CODECS);
    acceptCodecs.add('PCMU');
    acceptCodecs.add('PCMA');
    const usePcm16Ingest = (0, codecDecode_1.shouldUsePcm16Ingest)(acceptCodecs, env_1.env.TELNYX_AMRWB_DECODE, env_1.env.TELNYX_G722_DECODE, env_1.env.TELNYX_OPUS_DECODE);
    const targetSampleRateHz = env_1.env.TELNYX_TARGET_SAMPLE_RATE;
    const isCodecSupported = (codec) => {
        if (!acceptCodecs.has(codec)) {
            return { supported: false, reason: 'codec_not_accepted' };
        }
        if (codec === 'AMR-WB' && !env_1.env.TELNYX_AMRWB_DECODE) {
            return { supported: false, reason: 'amrwb_decode_disabled' };
        }
        if (codec === 'G722' && !env_1.env.TELNYX_G722_DECODE) {
            return { supported: false, reason: 'g722_decode_disabled' };
        }
        if (codec === 'OPUS' && !env_1.env.TELNYX_OPUS_DECODE) {
            return { supported: false, reason: 'opus_decode_disabled' };
        }
        if (!usePcm16Ingest && codec !== 'PCMU') {
            return { supported: false, reason: 'pcmu_only_mode' };
        }
        return { supported: true };
    };
    server.on('upgrade', (request, socket, head) => {
        const parsed = parseMediaRequest(request);
        if (!parsed) {
            socket.destroy();
            return;
        }
        if (!parsed.token || parsed.token !== env_1.env.MEDIA_STREAM_TOKEN) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.callControlId = parsed.callControlId;
            wss.emit('connection', ws, request);
        });
    });
    wss.on('connection', (ws, request) => {
        const connection = ws;
        const callControlId = connection.callControlId;
        if (!callControlId) {
            ws.close(1008, 'invalid_call_control_id');
            return;
        }
        sessionManager.registerMediaConnection(callControlId, ws);
        if (debugMedia) {
            log_1.log.info({
                event: 'media_ws_connected',
                call_control_id: callControlId,
                remote: request.socket.remoteAddress,
                url: request.url,
            }, 'media ws connected');
        }
        const getString = (value) => typeof value === 'string' && value.trim() !== '' ? value : undefined;
        const getNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
        const logDecodeUnsupportedOnce = (codec, reason) => {
            if (connection.decodeUnsupportedLogged) {
                return;
            }
            connection.decodeUnsupportedLogged = true;
            log_1.log.warn({
                event: 'telnyx_codec_unsupported',
                call_control_id: callControlId,
                encoding: codec,
                reason,
            }, 'telnyx codec unsupported for decode');
        };
        const logDecodeFailedOnce = (codec, reason) => {
            if (!connection.decodeFailedLogged) {
                connection.decodeFailedLogged = new Set();
            }
            if (connection.decodeFailedLogged.has(codec)) {
                return;
            }
            connection.decodeFailedLogged.add(codec);
            if (codec === 'AMR-WB' && !connection.amrwbFallbackLogged) {
                connection.amrwbFallbackLogged = true;
                log_1.log.warn({
                    event: 'amrwb_fallback',
                    call_control_id: callControlId,
                    reason,
                    negotiated_codec: codec,
                }, 'amr-wb decode failed; falling back');
            }
            if (codec === 'AMR-WB') {
                connection.amrwbDecodeFailureCount = (connection.amrwbDecodeFailureCount ?? 0) + 1;
                log_1.log.warn({
                    event: 'amrwb_decode_failed',
                    call_control_id: callControlId,
                    reason,
                    failure_count: connection.amrwbDecodeFailureCount,
                }, 'amr-wb decode failed');
            }
            log_1.log.warn({
                event: 'telnyx_codec_decode_failed',
                call_control_id: callControlId,
                encoding: codec,
                reason,
            }, 'telnyx codec decode failed');
        };
        const handleMediaPayload = async (buffer) => {
            try {
                const encoding = normalizeCodec(connection.mediaEncoding);
                const probeMeta = buildProbeMeta(callControlId, connection);
                (0, audioProbe_1.attachAudioMeta)(buffer, probeMeta);
                if (!connection.diagRawLogged) {
                    connection.diagRawLogged = true;
                    if (shouldProbeRaw(probeMeta.codec)) {
                        (0, audioProbe_1.probePcm)('rx.telnyx.raw', buffer, probeMeta);
                    }
                    else if ((0, audioProbe_1.diagnosticsEnabled)()) {
                        // Skip PCM analysis for compressed codecs; keep the socket open for diagnostics.
                        log_1.log.info({
                            event: 'audio_probe_skipped',
                            call_control_id: callControlId,
                            encoding: probeMeta.codec,
                            sample_rate: probeMeta.sampleRateHz,
                            channels: probeMeta.channels,
                        }, 'audio probe skipped for non-PCM codec');
                    }
                    (0, audioProbe_1.markAudioSpan)('rx', probeMeta);
                }
                if (connection.mediaUnsupported) {
                    return;
                }
                if (!usePcm16Ingest) {
                    const ok = sessionManager.pushAudio(callControlId, buffer);
                    if (!ok) {
                        log_1.log.warn({ event: 'media_orphan_frame', call_control_id: callControlId }, 'media orphan frame');
                    }
                    return;
                }
                if (!acceptCodecs.has(encoding)) {
                    logDecodeUnsupportedOnce(encoding, 'codec_not_accepted');
                    return;
                }
                const decodeResult = await (0, codecDecode_1.decodeTelnyxPayloadToPcm16)({
                    encoding,
                    payload: buffer,
                    channels: connection.mediaChannels ?? 1,
                    reportedSampleRateHz: connection.mediaSampleRate,
                    targetSampleRateHz,
                    allowAmrWb: env_1.env.TELNYX_AMRWB_DECODE,
                    allowG722: env_1.env.TELNYX_G722_DECODE,
                    allowOpus: env_1.env.TELNYX_OPUS_DECODE,
                    state: connection.codecState ?? (connection.codecState = {}),
                    logContext: { call_control_id: callControlId },
                });
                if (!decodeResult) {
                    const failureReason = encoding === 'AMR-WB' && connection.codecState?.amrwbLastError
                        ? connection.codecState.amrwbLastError
                        : 'decode_failed';
                    logDecodeFailedOnce(encoding, failureReason);
                    return;
                }
                const pcmBuffer = Buffer.from(decodeResult.pcm16.buffer, decodeResult.pcm16.byteOffset, decodeResult.pcm16.byteLength);
                const decodedMeta = {
                    callId: callControlId,
                    format: 'pcm16le',
                    codec: encoding,
                    sampleRateHz: decodeResult.sampleRateHz,
                    channels: 1,
                    bitDepth: 16,
                    logContext: { call_control_id: callControlId },
                    lineage: ['rx.decoded.pcm16'],
                };
                (0, audioProbe_1.attachAudioMeta)(pcmBuffer, decodedMeta);
                if ((0, audioProbe_1.diagnosticsEnabled)() && !connection.diagDecodedLogged) {
                    connection.diagDecodedLogged = true;
                    (0, audioProbe_1.probePcm)('rx.decoded.pcm16', pcmBuffer, decodedMeta);
                }
                if (encoding === 'AMR-WB' && !connection.amrwbDecodeLogged) {
                    connection.amrwbDecodeLogged = true;
                    log_1.log.info({
                        event: 'amrwb_decode_success',
                        call_control_id: callControlId,
                        sample_rate: decodeResult.sampleRateHz,
                    }, 'amr-wb decode success');
                }
                const ok = sessionManager.pushPcm16(callControlId, decodeResult.pcm16, decodeResult.sampleRateHz);
                if (!ok) {
                    log_1.log.warn({ event: 'media_orphan_frame', call_control_id: callControlId }, 'media orphan frame');
                }
            }
            catch (error) {
                log_1.log.warn({ event: 'telnyx_media_decode_error', call_control_id: callControlId, err: error }, 'telnyx media decode error');
            }
        };
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                const buffer = Buffer.isBuffer(data)
                    ? data
                    : Array.isArray(data)
                        ? Buffer.concat(data)
                        : Buffer.from(data);
                connection.frameSeq = (connection.frameSeq ?? 0) + 1;
                if (debugMedia && connection.frameSeq % 50 === 0) {
                    log_1.log.info({ event: 'media_frame', call_control_id: callControlId, bytes: buffer.length, seq: connection.frameSeq }, 'media frame');
                }
                void handleMediaPayload(buffer);
                return;
            }
            const text = typeof data === 'string'
                ? data
                : Buffer.isBuffer(data)
                    ? data.toString('utf8')
                    : Array.isArray(data)
                        ? Buffer.concat(data).toString('utf8')
                        : '';
            if (!text) {
                return;
            }
            let message;
            try {
                message = JSON.parse(text);
            }
            catch (error) {
                if (debugMedia) {
                    log_1.log.warn({ event: 'media_ws_parse_failed', call_control_id: callControlId, err: error }, 'media ws parse failed');
                }
                return;
            }
            const event = typeof message.event === 'string' ? message.event : undefined;
            if (debugMedia) {
                connection.msgSeq = (connection.msgSeq ?? 0) + 1;
                if (connection.msgSeq % 25 === 0) {
                    log_1.log.info({
                        event: 'media_ws_msg',
                        call_control_id: callControlId,
                        msg_event: event,
                        keys: Object.keys(message),
                    }, 'media ws message');
                }
            }
            if (event === 'connected') {
                if (debugMedia) {
                    log_1.log.info({ event: 'media_ws_event_connected', call_control_id: callControlId }, 'media ws connected event');
                }
                return;
            }
            if (event === 'start') {
                const start = message.start && typeof message.start === 'object' ? message.start : {};
                const mediaFormat = start.media_format ??
                    message.media_format ??
                    undefined;
                const encoding = mediaFormat ? getString(mediaFormat.encoding) : undefined;
                const sampleRate = mediaFormat
                    ? getNumber(mediaFormat.sample_rate ?? mediaFormat.sampleRate)
                    : undefined;
                const channels = mediaFormat ? getNumber(mediaFormat.channels) : undefined;
                const normalizedEncoding = normalizeCodec(encoding ?? connection.mediaEncoding);
                if (encoding) {
                    connection.mediaEncoding = normalizedEncoding;
                    connection.mediaSampleRate = sampleRate ?? (normalizedEncoding === 'AMR-WB' ? 16000 : undefined);
                    connection.mediaChannels = channels;
                }
                const support = isCodecSupported(normalizedEncoding);
                connection.mediaUnsupported = !support.supported;
                if ((0, audioProbe_1.diagnosticsEnabled)()) {
                    log_1.log.info({
                        event: 'audio_codec_info',
                        direction: 'rx.telnyx',
                        call_control_id: callControlId,
                        encoding: normalizedEncoding,
                        sample_rate: sampleRate,
                        channels,
                        expected_encoding: process.env.TELNYX_STREAM_CODEC ?? 'PCMU',
                        expected_sample_rate: undefined,
                        pcm16_ingest: usePcm16Ingest,
                        target_sample_rate_hz: targetSampleRateHz,
                        accept_codecs: Array.from(acceptCodecs),
                        amrwb_decode_enabled: env_1.env.TELNYX_AMRWB_DECODE,
                        g722_decode_enabled: env_1.env.TELNYX_G722_DECODE,
                        opus_decode_enabled: env_1.env.TELNYX_OPUS_DECODE,
                    }, 'audio codec info');
                }
                if (normalizedEncoding && !connection.mediaCodecLogged) {
                    connection.mediaCodecLogged = true;
                    if (normalizedEncoding !== 'AMR-WB' &&
                        acceptCodecs.has('AMR-WB') &&
                        env_1.env.TELNYX_AMRWB_DECODE &&
                        !connection.amrwbFallbackLogged) {
                        connection.amrwbFallbackLogged = true;
                        log_1.log.warn({
                            event: 'amrwb_fallback',
                            call_control_id: callControlId,
                            reason: 'carrier_downgrade',
                            negotiated_codec: normalizedEncoding,
                        }, 'amr-wb not negotiated; falling back');
                    }
                    if (normalizedEncoding === 'AMR-WB' && !env_1.env.TELNYX_AMRWB_DECODE && !connection.amrwbFallbackLogged) {
                        connection.amrwbFallbackLogged = true;
                        log_1.log.warn({
                            event: 'amrwb_fallback',
                            call_control_id: callControlId,
                            reason: 'decode_disabled',
                            negotiated_codec: normalizedEncoding,
                        }, 'amr-wb negotiated but decode disabled');
                    }
                    log_1.log.info({
                        event: 'media_ws_codec_confirmed',
                        call_control_id: callControlId,
                        codec: normalizedEncoding,
                        encoding: normalizedEncoding,
                        sample_rate: sampleRate ?? (normalizedEncoding === 'AMR-WB' ? 16000 : undefined),
                    }, 'media ws codec confirmed');
                    if (normalizedEncoding === 'AMR-WB' &&
                        env_1.env.TELNYX_AMRWB_DECODE &&
                        !connection.amrwbEnabledLogged) {
                        connection.amrwbEnabledLogged = true;
                        log_1.log.info({
                            event: 'amrwb_decode_enabled',
                            call_control_id: callControlId,
                            sample_rate: 16000,
                        }, 'amr-wb decode enabled');
                    }
                }
                // Codec negotiation can vary by leg. Don't hard-fail the stream here.
                // Log once so we can confirm what Telnyx reports, but keep the socket alive.
                if (normalizedEncoding && normalizedEncoding !== 'PCMU') {
                    unsupportedEncodingCount += 1;
                    log_1.log.warn({
                        event: 'non_pcmu_media_encoding_reported',
                        call_control_id: callControlId,
                        encoding: normalizedEncoding,
                        sample_rate: sampleRate,
                        channels,
                        note: support.supported
                            ? 'Stream reported non-PCMU. Decode path enabled if configured.'
                            : `Stream reported non-PCMU. Unsupported (${support.reason ?? 'unknown'}). Keeping WS open for diagnostics.`,
                        unsupported_encoding_count: unsupportedEncodingCount,
                    }, 'Non-PCMU encoding reported (WS kept open for diagnostics)');
                }
                if (!support.supported) {
                    logDecodeUnsupportedOnce(normalizedEncoding, support.reason ?? 'unsupported_codec');
                }
                // IMPORTANT: do NOT close the socket here.
                if (debugMedia) {
                    log_1.log.info({
                        event: 'media_ws_event_start',
                        call_control_id: callControlId,
                        media_format: mediaFormat,
                        start_keys: Object.keys(start),
                    }, 'media ws start');
                }
                return;
            }
            if (event === 'stop') {
                if (debugMedia) {
                    log_1.log.info({ event: 'media_ws_event_stop', call_control_id: callControlId }, 'media ws stop');
                }
                ws.close(1000, 'media_stop');
                return;
            }
            if (event !== 'media') {
                return;
            }
            const media = message.media && typeof message.media === 'object' ? message.media : undefined;
            const payload = media?.payload ??
                message.payload;
            if (!payload) {
                return;
            }
            let buffer;
            try {
                buffer = Buffer.from(payload, 'base64');
            }
            catch (error) {
                if (debugMedia) {
                    log_1.log.warn({ event: 'media_ws_decode_failed', call_control_id: callControlId, err: error }, 'media ws decode failed');
                }
                return;
            }
            connection.frameSeq = (connection.frameSeq ?? 0) + 1;
            if (debugMedia && connection.frameSeq % 50 === 0) {
                log_1.log.info({ event: 'media_frame', call_control_id: callControlId, bytes: buffer.length, seq: connection.frameSeq }, 'media frame');
            }
            void handleMediaPayload(buffer);
        });
        ws.on('close', () => {
            sessionManager.unregisterMediaConnection(callControlId, ws);
        });
        ws.on('error', (error) => {
            sessionManager.unregisterMediaConnection(callControlId, ws);
            log_1.log.error({ err: error, call_control_id: callControlId }, 'media websocket error');
        });
    });
    return wss;
}
async function ensureGreetingAsset() {
    const greetingPath = path_1.default.join(env_1.env.AUDIO_STORAGE_DIR, 'greeting.wav');
    try {
        const stats = await fs_1.default.promises.stat(greetingPath);
        log_1.log.info({ path: greetingPath, created: false, bytes: stats.size }, 'greeting asset ready');
        return;
    }
    catch (error) {
        const code = error.code;
        if (code && code !== 'ENOENT') {
            log_1.log.warn({ err: error, path: greetingPath }, 'greeting asset stat failed');
        }
    }
    const voice = env_1.env.KOKORO_VOICE_ID ?? 'af_bella';
    try {
        const result = await (0, kokoroTTS_1.synthesizeSpeech)({
            text: 'Hi! Thanks for calling. How can I help you today?',
            voice,
            format: 'wav',
        });
        logTtsBytesReady('greeting.wav', result.audio, result.contentType, { path: greetingPath });
        const pipelineApplied = env_1.env.PLAYBACK_PROFILE === 'pstn';
        if (pipelineApplied) {
            const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', 'unknown');
            const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(result.audio, {
                targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                logContext: { path: greetingPath },
            });
            endPipeline();
            result.audio = pipelineResult.audio;
        }
        const pipelineMeta = (0, audioProbe_1.getAudioMeta)(result.audio) ?? {
            format: 'wav',
            logContext: { path: greetingPath },
            lineage: ['pipeline:unknown'],
        };
        if (pipelineApplied) {
            (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', result.audio, pipelineMeta);
        }
        (0, audioProbe_1.probeWav)('tx.telnyx.payload', result.audio, { ...pipelineMeta, kind: 'greeting.wav' });
        try {
            const info = (0, wavInfo_1.parseWavInfo)(result.audio);
            log_1.log.info({
                event: 'wav_info',
                source: 'pipeline_output',
                id: 'greeting.wav',
                sample_rate_hz: info.sampleRateHz,
                channels: info.channels,
                bits_per_sample: info.bitsPerSample,
                data_bytes: info.dataBytes,
                duration_ms: info.durationMs,
                path: greetingPath,
            }, 'wav info');
        }
        catch (error) {
            log_1.log.warn({
                event: 'wav_info_parse_failed',
                source: 'pipeline_output',
                id: 'greeting.wav',
                reason: getErrorMessage(error),
                path: greetingPath,
            }, 'wav info parse failed');
        }
        await fs_1.default.promises.writeFile(greetingPath, result.audio);
        log_1.log.info({ path: greetingPath, created: true, bytes: result.audio.length }, 'greeting asset ready');
    }
    catch (error) {
        log_1.log.error({ err: error, path: greetingPath }, 'greeting asset creation failed');
    }
}
function buildServer() {
    const app = (0, express_1.default)();
    const sessionManager = new sessionManager_1.SessionManager();
    // --- Metrics first: capture full request time including JSON parsing + downstream work.
    app.use(metrics_1.metricsMiddleware);
    app.get('/metrics', metrics_1.metricsHandler);
    fs_1.default.mkdirSync(env_1.env.AUDIO_STORAGE_DIR, { recursive: true });
    log_1.log.info({ audioDir: env_1.env.AUDIO_STORAGE_DIR }, 'audio hosting configured');
    log_1.log.info({
        telnyx_stream_track: env_1.env.TELNYX_STREAM_TRACK,
        stt_min_seconds: env_1.env.STT_MIN_SECONDS,
        stt_silence_min_seconds: env_1.env.STT_SILENCE_MIN_SECONDS,
        stt_partial_interval_ms: env_1.env.STT_PARTIAL_INTERVAL_MS,
        stt_max_utterance_ms: env_1.env.STT_MAX_UTTERANCE_MS,
    }, 'runtime tuning configured');
    void ensureGreetingAsset();
    app.disable('x-powered-by');
    app.use(express_1.default.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    }));
    app.use(requestIdMiddleware);
    app.use('/health', health_1.healthRouter);
    const publicDir = path_1.default.resolve(process.cwd(), 'public');
    app.use('/public', express_1.default.static(publicDir));
    app.get('/hd-call', (_req, res) => {
        res.sendFile(path_1.default.join(publicDir, 'hd-call.html'));
    });
    app.get('/health/audio', (_req, res) => {
        const dir = env_1.env.AUDIO_STORAGE_DIR;
        const exists = fs_1.default.existsSync(dir);
        let fileCount = 0;
        if (exists) {
            try {
                fileCount = fs_1.default.readdirSync(dir).length;
            }
            catch (error) {
                log_1.log.warn({ err: error, dir }, 'audio health check read failed');
            }
        }
        res.status(200).json({ dir, exists, fileCount });
    });
    app.use('/audio', playbackServeTimer(), wavInfoLogger('/audio'), express_1.default.static(env_1.env.AUDIO_STORAGE_DIR));
    app.use('/v1/webrtc', (0, webrtc_1.createWebRtcRouter)(sessionManager));
    const telnyxWebhookRouter = (0, telnyxWebhook_1.createTelnyxWebhookRouter)(sessionManager);
    const telnyxWebhookRoutes = ['/v1/telnyx/webhook', '/api/telnyx/call-control'];
    for (const route of telnyxWebhookRoutes) {
        app.use(route, telnyxWebhookRouter);
    }
    log_1.log.info({ routes: telnyxWebhookRoutes }, 'telnyx webhook routes configured');
    app.use(errorHandler);
    const server = http_1.default.createServer(app);
    attachMediaWebSocketServer(server, sessionManager);
    return { app, server, sessionManager };
}
//# sourceMappingURL=server.js.map