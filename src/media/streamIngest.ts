import { log } from '../log';
import { MediaFrame, MediaFrameEnvelope, MediaStreamConfig } from './types';

export class StreamIngest {
  constructor(private readonly config: MediaStreamConfig) {}

  public ingest(frame: MediaFrame | MediaFrameEnvelope): void {
    const payload = Buffer.isBuffer(frame) ? frame : frame.data;
    const timestampMs = Buffer.isBuffer(frame) ? undefined : frame.timestampMs;
    log.debug(
      {
        timestampMs,
        bytes: payload.length,
        sampleRate: this.config.sampleRate,
      },
      'media frame ingested',
    );
  }
}