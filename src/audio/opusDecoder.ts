import OpusScript from 'opusscript';

const OPUS_SAMPLE_RATE_HZ = 48000;
const OPUS_CHANNELS = 1;

export class OpusPacketDecoder {
  private decoder: OpusScript;
  private readonly channels: number;

  constructor(channels: number = OPUS_CHANNELS) {
    this.channels = Math.max(1, channels);
    this.decoder = new OpusScript(OPUS_SAMPLE_RATE_HZ, this.channels, OpusScript.Application.AUDIO);
  }

  public decode(packet: Buffer): Int16Array {
    if (!packet || packet.length === 0) {
      return new Int16Array(0);
    }
    const pcm = this.decoder.decode(packet);
    return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  }

  public getChannels(): number {
    return this.channels;
  }

  public getSampleRateHz(): number {
    return OPUS_SAMPLE_RATE_HZ;
  }
}
