"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpusPacketDecoder = void 0;
const opusscript_1 = __importDefault(require("opusscript"));
const OPUS_SAMPLE_RATE_HZ = 48000;
const OPUS_CHANNELS = 1;
class OpusPacketDecoder {
    constructor(channels = OPUS_CHANNELS) {
        this.channels = Math.max(1, channels);
        this.decoder = new opusscript_1.default(OPUS_SAMPLE_RATE_HZ, this.channels, opusscript_1.default.Application.AUDIO);
    }
    decode(packet) {
        if (!packet || packet.length === 0) {
            return new Int16Array(0);
        }
        const pcm = this.decoder.decode(packet);
        return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    }
    getChannels() {
        return this.channels;
    }
    getSampleRateHz() {
        return OPUS_SAMPLE_RATE_HZ;
    }
}
exports.OpusPacketDecoder = OpusPacketDecoder;
//# sourceMappingURL=opusDecoder.js.map