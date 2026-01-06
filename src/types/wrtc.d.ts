declare module 'wrtc' {
  export interface RTCSessionDescriptionInit {
    type: 'offer' | 'answer';
    sdp?: string;
  }

  export interface RTCIceServer {
    urls: string | string[];
  }

  export interface RTCConfiguration {
    iceServers?: RTCIceServer[];
  }

  export interface MediaStreamTrack {
    kind: 'audio' | 'video';
    stop(): void;
  }

  export interface RTCAudioData {
    samples: Int16Array;
    sampleRate: number;
    bitsPerSample: number;
    channelCount: number;
    numberOfFrames: number;
  }

  export class RTCPeerConnection {
    constructor(configuration?: RTCConfiguration);
    localDescription?: RTCSessionDescriptionInit | null;
    connectionState: string;
    iceGatheringState: string;
    ontrack: ((event: { track: MediaStreamTrack }) => void) | null;
    onconnectionstatechange: (() => void) | null;
    onicegatheringstatechange: (() => void) | null;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addTrack(track: MediaStreamTrack): void;
    close(): void;
  }

  export namespace nonstandard {
    class RTCAudioSource {
      createTrack(): MediaStreamTrack;
      onData(data: RTCAudioData): void;
    }

    class RTCAudioSink {
      constructor(track: MediaStreamTrack);
      ondata?: (data: RTCAudioData) => void;
      stop(): void;
    }
  }
}