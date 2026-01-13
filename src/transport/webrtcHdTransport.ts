import { log } from '../log';
import { startStageTimer } from '../metrics';
import type { AudioIngest, AudioPlayback, PlaybackInput, TransportSession } from './types';

import type * as wrtcTypes from 'wrtc';

type WrtcModule = typeof wrtcTypes;

interface AudioFrameData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample: number;
  channelCount: number;
  numberOfFrames: number;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown_error';
}

type SdpAudioLines = {
  mLine: string | null;
  rtpmapLines: string[];
  fmtpLines: string[];
  notes: string[];
};

function extractAudioSdpLines(sdp: string | undefined): SdpAudioLines {
  const notes: string[] = [];
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
  if (sectionEnd === -1) sectionEnd = lines.length;
  const section = lines.slice(audioIndex + 1, sectionEnd);
  const rtpmapLines = section.filter((line) => line.startsWith('a=rtpmap:'));
  const fmtpLines = section.filter((line) => line.startsWith('a=fmtp:'));

  if (rtpmapLines.length === 0) notes.push('missing_rtpmap');
  if (fmtpLines.length === 0) notes.push('missing_fmtp');

  return { mLine, rtpmapLines, fmtpLines, notes };
}


let _wrtc: any | null = null;

function loadWrtc() {
  if (_wrtc) return _wrtc;

  const tried: string[] = [];

  // Prefer @roamhq/wrtc on Mac/Apple Silicon
  try {
    tried.push("@roamhq/wrtc");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _wrtc = require("@roamhq/wrtc");
    log.info({ event: "webrtc_wrtc_loaded", module: "@roamhq/wrtc" }, "wrtc loaded");
    return _wrtc;
  } catch (e) {
    // keep going
  }

  // Fallback to legacy wrtc if present
  try {
    tried.push("wrtc");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _wrtc = require("wrtc");
    log.info({ event: "webrtc_wrtc_loaded", module: "wrtc" }, "wrtc loaded");
    return _wrtc;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    throw new Error(`wrtc_unavailable:${msg} (tried: ${tried.join(", ")})`);
  }
}


function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

function resamplePcm16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
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

function parseWavHeader(buffer: Buffer): {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
} {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('invalid_riff_header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
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
    } else if (chunkId === 'data') {
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

function decodeWavPcm16Mono(buffer: Buffer): { samples: Int16Array; sampleRateHz: number } {
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
    if (offset + 2 > buffer.length) break;
    pcm[i] = buffer.readInt16LE(offset);
  }

  return { samples: pcm, sampleRateHz: header.sampleRateHz };
}

class WebRtcAudioIngest implements AudioIngest {
  private onFrameCb?: (frame: Buffer) => void;

  start(): void {
    // no-op: WebRTC sink drives ingest
  }

  stop(): void {
    this.onFrameCb = undefined;
  }

  onFrame(cb: (frame: Buffer) => void): void {
    this.onFrameCb = cb;
  }

  emitFrame(frame: Buffer): void {
    this.onFrameCb?.(frame);
  }
}

class WebRtcAudioPlayback implements AudioPlayback {
  private readonly audioSource: wrtcTypes.nonstandard.RTCAudioSource;
  private readonly logContext: Record<string, unknown>;
  private readonly outputSampleRate: number;
  private playbackTimer?: NodeJS.Timeout;
  private playbackStopped = false;
  private readonly playbackEndCallbacks: Array<() => void> = [];

  constructor(options: {
    audioSource: wrtcTypes.nonstandard.RTCAudioSource;
    logContext: Record<string, unknown>;
    outputSampleRate: number;
  }) {
    this.audioSource = options.audioSource;
    this.logContext = options.logContext;
    this.outputSampleRate = options.outputSampleRate;
  }

  onPlaybackEnd(cb: () => void): void {
    this.playbackEndCallbacks.push(cb);
  }

  async play(input: PlaybackInput): Promise<void> {
    if (input.kind !== 'buffer') {
      log.warn({ event: 'webrtc_playback_requires_buffer', ...this.logContext }, 'webrtc playback expects buffer');
      return;
    }

    await this.stop();
    this.playbackStopped = false;

    let pcm: Int16Array;
    let sampleRateHz: number;
    try {
      const decoded = decodeWavPcm16Mono(input.audio);
      pcm = decoded.samples;
      sampleRateHz = decoded.sampleRateHz;
    } catch (error) {
      log.warn({ event: 'webrtc_wav_decode_failed', reason: getErrorMessage(error), ...this.logContext }, 'webrtc wav decode failed');
      this.emitPlaybackEnd();
      return;
    }

    const resampled = resamplePcm16(pcm, sampleRateHz, this.outputSampleRate);
    const frameSamples = Math.max(1, Math.floor(this.outputSampleRate / 100));
    const totalFrames = Math.ceil(resampled.length / frameSamples);

    await new Promise<void>((resolve) => {
      let frameIndex = 0;
      const sendFrame = (): void => {
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

        const audioFrame: AudioFrameData = {
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

  async stop(): Promise<void> {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = undefined;
    }
    this.playbackStopped = true;
  }

  private emitPlaybackEnd(): void {
    for (const cb of this.playbackEndCallbacks) {
      try {
        cb();
      } catch (error) {
        log.warn({ err: error, ...this.logContext }, 'webrtc playback end callback failed');
      }
    }
  }
}

export class WebRtcHdTransportSession implements TransportSession {
  public readonly id: string;
  public readonly mode = 'webrtc_hd' as const;
  public readonly ingest: WebRtcAudioIngest;
  public readonly playback: WebRtcAudioPlayback;
  public readonly audioInput = { codec: 'pcm16le' as const, sampleRateHz: 16000 };

  private readonly logContext: Record<string, unknown>;
  private readonly tenantLabel: string;
  private readonly wrtc: WrtcModule;
  private readonly pc: wrtcTypes.RTCPeerConnection;
  private readonly audioSource: wrtcTypes.nonstandard.RTCAudioSource;
  private readonly outputSampleRate: number;
  private audioSink?: wrtcTypes.nonstandard.RTCAudioSink;
  private readonly onSessionEnded?: (reason: string) => void;
  private sdpAudioLogged = false;

  constructor(options: {
    sessionId: string;
    tenantId?: string;
    requestId?: string;
    outputSampleRate?: number;
    onSessionEnded?: (reason: string) => void;
  }) {
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
      this.audioSink.ondata = (data: AudioFrameData) => {
        if (!data || data.channelCount !== 1) {
          return;
        }
        const endIngest = startStageTimer('webrtc_ingest_ms', this.tenantLabel);
        try {
          const samples = data.samples ?? new Int16Array();
          const sampleRate = data.sampleRate || this.outputSampleRate;
          const resampled = resamplePcm16(samples, sampleRate, this.audioInput.sampleRateHz);
          const buffer = Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
          this.ingest.emitFrame(buffer);
        } finally {
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

  async acceptOffer(offer: wrtcTypes.RTCSessionDescriptionInit): Promise<wrtcTypes.RTCSessionDescriptionInit> {
    const endHandshake = startStageTimer('webrtc_handshake_ms', this.tenantLabel);
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
    } finally {
      endHandshake();
    }
  }

  async start(): Promise<void> {
    // WebRTC is started by offer/answer; nothing to do here.
  }

  private logSdpAudioOnce(offerSdp: string | undefined, answerSdp: string | undefined): void {
    if (this.sdpAudioLogged) return;
    this.sdpAudioLogged = true;
    try {
      const offer = extractAudioSdpLines(offerSdp);
      const answer = extractAudioSdpLines(answerSdp);
      log.info(
        {
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
        },
        'SDP_AUDIO audio sdp',
      );
    } catch (error) {
      log.warn({ event: 'sdp_audio_log_failed', err: error, ...this.logContext }, 'SDP_AUDIO logging failed');
    }
  }

  async stop(reason?: string): Promise<void> {
    try {
      this.audioSink?.stop?.();
    } catch (error) {
      log.warn({ err: error, reason, ...this.logContext }, 'webrtc audio sink stop failed');
    }
    try {
      this.pc.close();
    } catch (error) {
      log.warn({ err: error, reason, ...this.logContext }, 'webrtc peer connection close failed');
    }
  }
}

async function waitForIceGathering(pc: wrtcTypes.RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return;
  }

  await new Promise<void>((resolve) => {
    const handler = (): void => {
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
