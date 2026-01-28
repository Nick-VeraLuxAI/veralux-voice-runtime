"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebRtcHdTransportSession = void 0;
const log_1 = require("../log");
const metrics_1 = require("../metrics");
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown_error';
}
function extractAudioSdpLines(sdp) {
    const notes = [];
    if (!sdp) {
        notes.push('missing_sdp');
        return { mLine: null, rtpmapLines: [], fmtpLines: [], notes };
    }
    const lines = sdp
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const audioIndex = lines.findIndex((line) => line.startsWith('m=audio'));
    if (audioIndex === -1) {
        notes.push('missing_m_audio');
        return { mLine: null, rtpmapLines: [], fmtpLines: [], notes };
    }
    const mLine = lines[audioIndex] ?? null;
    let sectionEnd = lines.findIndex((line, idx) => idx > audioIndex && line.startsWith('m='));
    if (sectionEnd === -1)
        sectionEnd = lines.length;
    const section = lines.slice(audioIndex + 1, sectionEnd);
    const rtpmapLines = section.filter((line) => line.startsWith('a=rtpmap:'));
    const fmtpLines = section.filter((line) => line.startsWith('a=fmtp:'));
    if (rtpmapLines.length === 0)
        notes.push('missing_rtpmap');
    if (fmtpLines.length === 0)
        notes.push('missing_fmtp');
    return { mLine, rtpmapLines, fmtpLines, notes };
}
let _wrtc = null;
function loadWrtc() {
    if (_wrtc)
        return _wrtc;
    const tried = [];
    // Prefer @roamhq/wrtc on Mac/Apple Silicon
    try {
        tried.push("@roamhq/wrtc");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _wrtc = require("@roamhq/wrtc");
        log_1.log.info({ event: "webrtc_wrtc_loaded", module: "@roamhq/wrtc" }, "wrtc loaded");
        return _wrtc;
    }
    catch (e) {
        // keep going
    }
    // Fallback to legacy wrtc if present
    try {
        tried.push("wrtc");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _wrtc = require("wrtc");
        log_1.log.info({ event: "webrtc_wrtc_loaded", module: "wrtc" }, "wrtc loaded");
        return _wrtc;
    }
    catch (e) {
        const msg = e?.message ?? String(e);
        throw new Error(`wrtc_unavailable:${msg} (tried: ${tried.join(", ")})`);
    }
}
function clampInt16(value) {
    if (value > 32767)
        return 32767;
    if (value < -32768)
        return -32768;
    return value | 0;
}
function resamplePcm16(input, inputRate, outputRate) {
    if (inputRate <= 0 || outputRate <= 0 || input.length === 0) {
        return input;
    }
    if (inputRate === outputRate) {
        return input;
    }
    const outputLength = Math.max(1, Math.round(input.length * (outputRate / inputRate)));
    const output = new Int16Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i += 1) {
        const position = i * ratio;
        const index = Math.floor(position);
        const nextIndex = Math.min(index + 1, input.length - 1);
        const frac = position - index;
        const sample0 = input[index] ?? 0;
        const sample1 = input[nextIndex] ?? sample0;
        output[i] = clampInt16(Math.round(sample0 + (sample1 - sample0) * frac));
    }
    return output;
}
function parseWavHeader(buffer) {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('invalid_riff_header');
    }
    let offset = 12;
    let audioFormat = null;
    let channels = null;
    let sampleRateHz = null;
    let bitsPerSample = null;
    let dataOffset = 0;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        if (chunkId === 'fmt ') {
            if (chunkStart + 16 > buffer.length) {
                throw new Error('fmt_chunk_truncated');
            }
            audioFormat = buffer.readUInt16LE(chunkStart);
            channels = buffer.readUInt16LE(chunkStart + 2);
            sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
            bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
        }
        else if (chunkId === 'data') {
            dataOffset = chunkStart;
            dataBytes = chunkSize;
        }
        const paddedSize = chunkSize + (chunkSize % 2);
        const nextOffset = chunkStart + paddedSize;
        if (nextOffset <= offset) {
            break;
        }
        offset = nextOffset;
    }
    if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
        throw new Error('missing_fmt_chunk');
    }
    if (dataOffset === 0 || dataBytes === 0) {
        throw new Error('missing_data_chunk');
    }
    return {
        audioFormat,
        channels,
        sampleRateHz,
        bitsPerSample,
        dataOffset,
        dataBytes,
    };
}
function decodeWavPcm16Mono(buffer) {
    const header = parseWavHeader(buffer);
    if (header.audioFormat !== 1) {
        throw new Error('unsupported_audio_format');
    }
    if (header.channels !== 1) {
        throw new Error('unsupported_channel_count');
    }
    if (header.bitsPerSample !== 16) {
        throw new Error('unsupported_bits_per_sample');
    }
    const availableBytes = Math.min(header.dataBytes, Math.max(0, buffer.length - header.dataOffset));
    if (availableBytes <= 0) {
        throw new Error('invalid_data_bytes');
    }
    const sampleCount = Math.floor(availableBytes / 2);
    const pcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
        const offset = header.dataOffset + i * 2;
        if (offset + 2 > buffer.length)
            break;
        pcm[i] = buffer.readInt16LE(offset);
    }
    return { samples: pcm, sampleRateHz: header.sampleRateHz };
}
class WebRtcAudioIngest {
    start() {
        // no-op: WebRTC sink drives ingest
    }
    stop() {
        this.onFrameCb = undefined;
    }
    onFrame(cb) {
        this.onFrameCb = cb;
    }
    emitFrame(frame) {
        this.onFrameCb?.(frame);
    }
}
class WebRtcAudioPlayback {
    constructor(options) {
        this.playbackStopped = false;
        this.playbackEndCallbacks = [];
        this.audioSource = options.audioSource;
        this.logContext = options.logContext;
        this.outputSampleRate = options.outputSampleRate;
    }
    onPlaybackEnd(cb) {
        this.playbackEndCallbacks.push(cb);
    }
    async play(input) {
        if (input.kind !== 'buffer') {
            log_1.log.warn({ event: 'webrtc_playback_requires_buffer', ...this.logContext }, 'webrtc playback expects buffer');
            return;
        }
        await this.stop();
        this.playbackStopped = false;
        let pcm;
        let sampleRateHz;
        try {
            const decoded = decodeWavPcm16Mono(input.audio);
            pcm = decoded.samples;
            sampleRateHz = decoded.sampleRateHz;
        }
        catch (error) {
            log_1.log.warn({ event: 'webrtc_wav_decode_failed', reason: getErrorMessage(error), ...this.logContext }, 'webrtc wav decode failed');
            this.emitPlaybackEnd();
            return;
        }
        const resampled = resamplePcm16(pcm, sampleRateHz, this.outputSampleRate);
        const frameSamples = Math.max(1, Math.floor(this.outputSampleRate / 100));
        const totalFrames = Math.ceil(resampled.length / frameSamples);
        await new Promise((resolve) => {
            let frameIndex = 0;
            const sendFrame = () => {
                if (this.playbackStopped) {
                    resolve();
                    return;
                }
                const start = frameIndex * frameSamples;
                if (start >= resampled.length) {
                    resolve();
                    return;
                }
                const end = Math.min(start + frameSamples, resampled.length);
                const slice = resampled.subarray(start, end);
                const padded = slice.length === frameSamples ? slice : (() => {
                    const paddedFrame = new Int16Array(frameSamples);
                    paddedFrame.set(slice);
                    return paddedFrame;
                })();
                const audioFrame = {
                    samples: padded,
                    sampleRate: this.outputSampleRate,
                    bitsPerSample: 16,
                    channelCount: 1,
                    numberOfFrames: padded.length,
                };
                this.audioSource.onData(audioFrame);
                frameIndex += 1;
                if (frameIndex >= totalFrames) {
                    resolve();
                    return;
                }
                this.playbackTimer = setTimeout(sendFrame, 10);
            };
            this.playbackTimer = setTimeout(sendFrame, 0);
        });
        this.emitPlaybackEnd();
    }
    async stop() {
        if (this.playbackTimer) {
            clearTimeout(this.playbackTimer);
            this.playbackTimer = undefined;
        }
        this.playbackStopped = true;
    }
    emitPlaybackEnd() {
        for (const cb of this.playbackEndCallbacks) {
            try {
                cb();
            }
            catch (error) {
                log_1.log.warn({ err: error, ...this.logContext }, 'webrtc playback end callback failed');
            }
        }
    }
}
class WebRtcHdTransportSession {
    constructor(options) {
        this.mode = 'webrtc_hd';
        this.audioInput = { codec: 'pcm16le', sampleRateHz: 16000 };
        this.sdpAudioLogged = false;
        this.id = options.sessionId;
        this.tenantLabel = options.tenantId ?? 'unknown';
        this.logContext = {
            session_id: options.sessionId,
            tenant_id: options.tenantId,
            requestId: options.requestId,
        };
        this.onSessionEnded = options.onSessionEnded;
        this.wrtc = loadWrtc();
        this.outputSampleRate = options.outputSampleRate ?? 48000;
        this.pc = new this.wrtc.RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        const { RTCAudioSource, RTCAudioSink } = this.wrtc.nonstandard;
        this.audioSource = new RTCAudioSource();
        const track = this.audioSource.createTrack();
        this.pc.addTrack(track);
        this.ingest = new WebRtcAudioIngest();
        this.playback = new WebRtcAudioPlayback({
            audioSource: this.audioSource,
            logContext: this.logContext,
            outputSampleRate: this.outputSampleRate,
        });
        this.pc.ontrack = (event) => {
            if (event.track.kind !== 'audio') {
                return;
            }
            this.audioSink?.stop?.();
            this.audioSink = new RTCAudioSink(event.track);
            this.audioSink.ondata = (data) => {
                if (!data || data.channelCount !== 1) {
                    return;
                }
                const endIngest = (0, metrics_1.startStageTimer)('webrtc_ingest_ms', this.tenantLabel);
                try {
                    const samples = data.samples ?? new Int16Array();
                    const sampleRate = data.sampleRate || this.outputSampleRate;
                    const resampled = resamplePcm16(samples, sampleRate, this.audioInput.sampleRateHz);
                    const buffer = Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
                    this.ingest.emitFrame(buffer);
                }
                finally {
                    endIngest();
                }
            };
        };
        this.pc.onconnectionstatechange = () => {
            const state = this.pc.connectionState;
            if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                this.onSessionEnded?.(state);
            }
        };
    }
    async acceptOffer(offer) {
        const endHandshake = (0, metrics_1.startStageTimer)('webrtc_handshake_ms', this.tenantLabel);
        try {
            await this.pc.setRemoteDescription(offer);
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            await waitForIceGathering(this.pc);
            if (!this.pc.localDescription) {
                throw new Error('missing_local_description');
            }
            // instrumentation: log SDP audio details once per call
            this.logSdpAudioOnce(offer.sdp, this.pc.localDescription.sdp);
            return this.pc.localDescription;
        }
        finally {
            endHandshake();
        }
    }
    async start() {
        // WebRTC is started by offer/answer; nothing to do here.
    }
    logSdpAudioOnce(offerSdp, answerSdp) {
        if (this.sdpAudioLogged)
            return;
        this.sdpAudioLogged = true;
        try {
            const offer = extractAudioSdpLines(offerSdp);
            const answer = extractAudioSdpLines(answerSdp);
            log_1.log.info({
                event: 'sdp_audio',
                offer: {
                    m_line: offer.mLine,
                    rtpmap_lines: offer.rtpmapLines,
                    fmtp_lines: offer.fmtpLines,
                    notes: offer.notes,
                },
                answer: {
                    m_line: answer.mLine,
                    rtpmap_lines: answer.rtpmapLines,
                    fmtp_lines: answer.fmtpLines,
                    notes: answer.notes,
                },
                ...this.logContext,
            }, 'SDP_AUDIO audio sdp');
        }
        catch (error) {
            log_1.log.warn({ event: 'sdp_audio_log_failed', err: error, ...this.logContext }, 'SDP_AUDIO logging failed');
        }
    }
    async stop(reason) {
        try {
            this.audioSink?.stop?.();
        }
        catch (error) {
            log_1.log.warn({ err: error, reason, ...this.logContext }, 'webrtc audio sink stop failed');
        }
        try {
            this.pc.close();
        }
        catch (error) {
            log_1.log.warn({ err: error, reason, ...this.logContext }, 'webrtc peer connection close failed');
        }
    }
}
exports.WebRtcHdTransportSession = WebRtcHdTransportSession;
async function waitForIceGathering(pc) {
    if (pc.iceGatheringState === 'complete') {
        return;
    }
    await new Promise((resolve) => {
        const handler = () => {
            if (pc.iceGatheringState === 'complete') {
                pc.onicegatheringstatechange = null;
                resolve();
            }
        };
        pc.onicegatheringstatechange = handler;
        setTimeout(() => {
            pc.onicegatheringstatechange = null;
            resolve();
        }, 2000);
    });
}
//# sourceMappingURL=webrtcHdTransport.js.map