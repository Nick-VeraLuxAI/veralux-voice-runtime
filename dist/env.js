"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const emptyToUndefined = (value) => {
    if (typeof value === 'string' && value.trim() === '') {
        return undefined;
    }
    return value;
};
const stringToBoolean = (value) => {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === '')
            return undefined;
        if (normalized === 'true')
            return true;
        if (normalized === 'false')
            return false;
    }
    return value;
};
const sttRmsFloorFallback = (value) => {
    const normalized = emptyToUndefined(value);
    if (normalized !== undefined)
        return normalized;
    return emptyToUndefined(process.env.STT_RMS_THRESHOLD);
};
const numberFromEnv = (value) => {
    if (typeof value === 'boolean')
        return NaN;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '')
            return undefined;
        const normalized = trimmed.toLowerCase();
        if (normalized === 'true' || normalized === 'false')
            return NaN;
        return trimmed;
    }
    return value;
};
const sttFramesRequiredFallback = (value) => {
    const normalized = numberFromEnv(value);
    if (normalized !== undefined)
        return normalized;
    return numberFromEnv(process.env.STT_FRAMES_REQUIRED);
};
const ttsSampleRateFallback = (value) => {
    const normalized = emptyToUndefined(value);
    if (normalized !== undefined)
        return normalized;
    return emptyToUndefined(process.env.KOKORO_SAMPLE_RATE);
};
const EnvSchema = zod_1.z.object({
    /* ───────────────────────── Core ───────────────────────── */
    PORT: zod_1.z.coerce.number().int().positive(),
    NODE_ENV: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('development')),
    TRANSPORT_MODE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['pstn', 'webrtc_hd']).default('pstn')),
    WEBRTC_PORT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    WEBRTC_ALLOWED_ORIGINS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().optional()),
    AUDIO_DIAGNOSTICS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /* ───────────────────────── Telnyx ───────────────────────── */
    TELNYX_API_KEY: zod_1.z.string().min(1),
    TELNYX_PUBLIC_KEY: zod_1.z.string().min(1),
    TELNYX_STREAM_TRACK: zod_1.z
        .enum(['inbound_track', 'outbound_track', 'both_tracks'])
        .default('inbound_track'),
    TELNYX_STREAM_CODEC: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().optional()),
    TELNYX_SKIP_SIGNATURE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_ACCEPT_CODECS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('PCMU')),
    TELNYX_STREAM_RESTART_MAX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1)),
    TELNYX_INGEST_HEALTH_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1200)),
    TELNYX_INGEST_HEALTH_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TELNYX_INGEST_HEALTH_RESTART_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TELNYX_INGEST_POST_PLAYBACK_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1200)),
    TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(2000)),
    TELNYX_AMRWB_MIN_DECODED_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(320)),
    TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(3)),
    TELNYX_TARGET_SAMPLE_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(16000)),
    TELNYX_OPUS_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_G722_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_AMRWB_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    PUBLIC_BASE_URL: zod_1.z.string().min(1),
    AUDIO_PUBLIC_BASE_URL: zod_1.z.string().min(1),
    /* ───────────────────────── Media / Storage ───────────────────────── */
    MEDIA_STREAM_TOKEN: zod_1.z.string().min(1),
    AUDIO_STORAGE_DIR: zod_1.z.string().min(1),
    /* ───────────────────────── STT (Whisper) ───────────────────────── */
    WHISPER_URL: zod_1.z.string().min(1),
    ALLOW_HTTP_WAV_JSON: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_CHUNK_MS: zod_1.z.coerce.number().int().positive(),
    STT_SILENCE_MS: zod_1.z.coerce.number().int().positive(),
    STT_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.6)),
    STT_SILENCE_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.45)),
    /* Endpointing + gating (used by chunkedSTT.ts) */
    STT_SILENCE_END_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(700)),
    STT_PRE_ROLL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(200)),
    STT_MIN_UTTERANCE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(400)),
    STT_MAX_UTTERANCE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(6000)),
    /* Final utterance trimming */
    FINAL_TAIL_CUSHION_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(120)),
    FINAL_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(1.0)),
    FINAL_MIN_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    /* Speech detection thresholds */
    STT_RMS_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.015)),
    STT_PEAK_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.05)),
    STT_DISABLE_GATES: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_SPEECH_RMS_FLOOR: zod_1.z.preprocess(sttRmsFloorFallback, zod_1.z.coerce.number().positive().default(0.03)),
    STT_SPEECH_PEAK_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.05)),
    STT_SPEECH_FRAMES_REQUIRED: zod_1.z.preprocess(sttFramesRequiredFallback, zod_1.z.coerce.number().int().positive().optional()),
    /* Partial transcription */
    STT_PARTIAL_INTERVAL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(250)),
    STT_PARTIAL_MIN_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(600)),
    /* STT input DSP */
    STT_HIGHPASS_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    STT_HIGHPASS_CUTOFF_HZ: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(100)),
    /* STT debug dumps */
    STT_DEBUG_DUMP_WHISPER_WAVS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_DEBUG_DUMP_PCM16: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_DEBUG_DUMP_RX_WAV: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /* Dead air protection */
    DEAD_AIR_MS: zod_1.z.coerce.number().int().positive(),
    DEAD_AIR_NO_FRAMES_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(1500)),
    /* ───────────────────────── TTS ───────────────────────── */
    KOKORO_URL: zod_1.z.string().min(1),
    KOKORO_VOICE_ID: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    TTS_SAMPLE_RATE: zod_1.z.preprocess(ttsSampleRateFallback, zod_1.z.coerce.number().int().positive().default(8000)),
    PLAYBACK_PROFILE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['pstn', 'hd']).default('pstn')),
    PLAYBACK_PSTN_SAMPLE_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(8000)),
    PLAYBACK_ENABLE_HIGHPASS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /* ───────────────────────── Brain / LLM ───────────────────────── */
    BRAIN_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    BRAIN_TIMEOUT_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(8000)),
    BRAIN_STREAMING_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    BRAIN_STREAM_PATH: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('/reply/stream')),
    BRAIN_STREAM_PING_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(15000)),
    BRAIN_STREAM_FIRST_AUDIO_MAX_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(2000)),
    BRAIN_STREAM_SEGMENT_MIN_CHARS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(120)),
    BRAIN_STREAM_SEGMENT_NEXT_CHARS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(180)),
    /* ───────────────────────── Redis / Capacity ───────────────────────── */
    REDIS_URL: zod_1.z.string().min(1),
    GLOBAL_CONCURRENCY_CAP: zod_1.z.coerce.number().int().positive(),
    TENANT_CONCURRENCY_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    TENANT_CALLS_PER_MIN_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    CAPACITY_TTL_SECONDS: zod_1.z.coerce.number().int().positive(),
    TENANTMAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('tenantmap')),
    TENANTCFG_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('tenantcfg')),
    CAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('cap')),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
    throw new Error(`Invalid environment variables: ${issues}`);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map