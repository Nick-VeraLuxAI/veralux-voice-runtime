// src/env.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ───────────────────────── helpers ─────────────────────────

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const stringToBoolean = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return undefined;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
};

const numberFromEnv = (value: unknown): unknown => {
  // prevent z.coerce.number from treating booleans as 1/0
  if (typeof value === 'boolean') return NaN;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;

    // prevent 'true'/'false' from becoming NaN later in confusing ways
    const normalized = trimmed.toLowerCase();
    if (normalized === 'true' || normalized === 'false') return NaN;

    return trimmed; // allow z.coerce.number to do the conversion
  }

  return value;
};

// Back-compat: STT_RMS_THRESHOLD → STT_SPEECH_RMS_FLOOR
const sttRmsFloorFallback = (value: unknown): unknown => {
  const normalized = emptyToUndefined(value);
  if (normalized !== undefined) return normalized;
  return emptyToUndefined(process.env.STT_RMS_THRESHOLD);
};

// ✅ Back-compat / aliasing for frames-required
// Prefer the actual knob: STT_SPEECH_FRAMES_REQUIRED
// Allow legacy: STT_FRAMES_REQUIRED
const sttFramesRequiredFallback = (value: unknown): unknown => {
  const normalized = numberFromEnv(value);
  if (normalized !== undefined) return normalized;

  const fromSpeech = numberFromEnv(process.env.STT_SPEECH_FRAMES_REQUIRED);
  if (fromSpeech !== undefined) return fromSpeech;

  return numberFromEnv(process.env.STT_FRAMES_REQUIRED);
};

// ✅ Make STT_SILENCE_END_MS default to STT_SILENCE_MS when not set
// (So your CLI `STT_SILENCE_MS=900` actually drives endpointing if END_MS is missing.)
const sttSilenceEndFallback = (value: unknown): unknown => {
  const normalized = numberFromEnv(value);
  if (normalized !== undefined) return normalized;

  const fromEnd = numberFromEnv(process.env.STT_SILENCE_END_MS);
  if (fromEnd !== undefined) return fromEnd;

  return numberFromEnv(process.env.STT_SILENCE_MS);
};

// Back-compat: KOKORO_SAMPLE_RATE → TTS_SAMPLE_RATE
const ttsSampleRateFallback = (value: unknown): unknown => {
  const normalized = emptyToUndefined(value);
  if (normalized !== undefined) return normalized;
  return emptyToUndefined(process.env.KOKORO_SAMPLE_RATE);
};

// ───────────────────────── schema ─────────────────────────

const EnvSchema = z.object({
  /* ───────────────────────── Core ───────────────────────── */
  PORT: z.coerce.number().int().positive(),
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default('development')),
  TRANSPORT_MODE: z.preprocess(emptyToUndefined, z.enum(['pstn', 'webrtc_hd']).default('pstn')),
  WEBRTC_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  WEBRTC_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),
  AUDIO_DIAGNOSTICS: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* ───────────────────────── Telnyx ───────────────────────── */
  TELNYX_API_KEY: z.string().min(1),
  TELNYX_PUBLIC_KEY: z.string().min(1),
  TELNYX_STREAM_TRACK: z.enum(['inbound_track', 'outbound_track', 'both_tracks']).default('inbound_track'),
  TELNYX_STREAM_CODEC: z.preprocess(emptyToUndefined, z.string().optional()),
  TELNYX_SKIP_SIGNATURE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_ACCEPT_CODECS: z.preprocess(emptyToUndefined, z.string().default('PCMU')),
  TELNYX_STREAM_RESTART_MAX: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(1)),
  TELNYX_INGEST_HEALTH_GRACE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(1200)),
  TELNYX_INGEST_HEALTH_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  TELNYX_INGEST_HEALTH_RESTART_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  TELNYX_INGEST_POST_PLAYBACK_GRACE_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(1200),
  ),
  TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(2000),
  ),
  TELNYX_AMRWB_MIN_DECODED_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(320)),
  TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(3),
  ),
  TELNYX_TARGET_SAMPLE_RATE: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(16000)),
  TELNYX_OPUS_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_G722_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_AMRWB_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),

  PUBLIC_BASE_URL: z.string().min(1),
  AUDIO_PUBLIC_BASE_URL: z.string().min(1),

  /* ───────────────────────── Media / Storage ───────────────────────── */
  MEDIA_STREAM_TOKEN: z.string().min(1),
  AUDIO_STORAGE_DIR: z.string().min(1),

  /* ───────────────────────── STT (Whisper) ───────────────────────── */
  WHISPER_URL: z.string().min(1),
  ALLOW_HTTP_WAV_JSON: z.preprocess(stringToBoolean, z.boolean().default(false)),

  STT_CHUNK_MS: z.coerce.number().int().positive(),
  STT_SILENCE_MS: z.coerce.number().int().positive(),

  STT_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.6)),
  STT_SILENCE_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.45)),

  /* Endpointing + gating (used by chunkedSTT.ts) */
  // ✅ default to STT_SILENCE_MS via preprocess fallback
  STT_SILENCE_END_MS: z.preprocess(sttSilenceEndFallback, z.coerce.number().int().positive().default(700)),
  STT_PRE_ROLL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1200)),
  STT_MIN_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(400)),
  STT_MAX_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(6000)),

  /* Final utterance trimming */
  FINAL_TAIL_CUSHION_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(120)),
  FINAL_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1.0)),
  FINAL_MIN_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),

  /* Speech detection thresholds */
  STT_RMS_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.015)),
  STT_PEAK_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.05)),
  STT_DISABLE_GATES: z.preprocess(stringToBoolean, z.boolean().default(false)),

  STT_SPEECH_RMS_FLOOR: z.preprocess(sttRmsFloorFallback, z.coerce.number().positive().default(0.03)),
  STT_SPEECH_PEAK_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.05)),
  STT_SPEECH_FRAMES_REQUIRED: z.preprocess(
    sttFramesRequiredFallback,
    z.coerce.number().int().positive().optional(),
  ),

  /* Partial transcription */
  STT_PARTIAL_INTERVAL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(250)),
  STT_PARTIAL_MIN_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(600)),

  /* STT input DSP */
  STT_HIGHPASS_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_HIGHPASS_CUTOFF_HZ: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(100)),

  /* Tier 2: measured listen-after-playback grace (300–900ms based on segment length) */
  STT_POST_PLAYBACK_GRACE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  STT_POST_PLAYBACK_GRACE_MIN_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(300)),
  STT_POST_PLAYBACK_GRACE_MAX_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(900)),

  /* STT debug dumps */
  STT_DEBUG_DUMP_WHISPER_WAVS: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_PCM16: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_RX_WAV: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_FAR_END_REF: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* Tier 4: SpeexDSP AEC (requires libspeexdsp: brew install speex / apt install libspeexdsp-dev) */
  STT_AEC_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* Tier 5: Auto-calibration (noise floor + adaptive thresholds) */
  STT_NOISE_FLOOR_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_NOISE_FLOOR_ALPHA: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(1).default(0.05)),
  STT_NOISE_FLOOR_MIN_SAMPLES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(30)),
  STT_ADAPTIVE_RMS_MULTIPLIER: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(2.0)),
  STT_ADAPTIVE_PEAK_MULTIPLIER: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(2.5)),
  STT_ADAPTIVE_FLOOR_MIN_RMS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.01)),
  STT_ADAPTIVE_FLOOR_MIN_PEAK: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.03)),

  /* Tier 5: Late-final watchdog (force final if speech but no final in X sec) */
  STT_LATE_FINAL_WATCHDOG_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_LATE_FINAL_WATCHDOG_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),

  /* Dead air protection */
  DEAD_AIR_MS: z.coerce.number().int().positive(),
  DEAD_AIR_NO_FRAMES_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1500)),

  /* ───────────────────────── TTS ───────────────────────── */
  KOKORO_URL: z.string().min(1),
  KOKORO_VOICE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  TTS_SAMPLE_RATE: z.preprocess(ttsSampleRateFallback, z.coerce.number().int().positive().default(8000)),
  PLAYBACK_PROFILE: z.preprocess(emptyToUndefined, z.enum(['pstn', 'hd']).default('pstn')),
  PLAYBACK_PSTN_SAMPLE_RATE: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  PLAYBACK_ENABLE_HIGHPASS: z.preprocess(stringToBoolean, z.boolean().default(true)),

  /* ───────────────────────── Brain / LLM ───────────────────────── */
  BRAIN_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BRAIN_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  BRAIN_STREAMING_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  BRAIN_STREAM_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default('/reply/stream')),
  BRAIN_STREAM_PING_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(15000)),
  BRAIN_STREAM_FIRST_AUDIO_MAX_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2000)),
  BRAIN_STREAM_SEGMENT_MIN_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(120)),
  BRAIN_STREAM_SEGMENT_NEXT_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(180)),

  /* ───────────────────────── Redis / Capacity ───────────────────────── */
  REDIS_URL: z.string().min(1),

  GLOBAL_CONCURRENCY_CAP: z.coerce.number().int().positive(),
  TENANT_CONCURRENCY_CAP_DEFAULT: z.coerce.number().int().positive(),
  TENANT_CALLS_PER_MIN_CAP_DEFAULT: z.coerce.number().int().positive(),
  CAPACITY_TTL_SECONDS: z.coerce.number().int().positive(),

  TENANTMAP_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('tenantmap')),
  TENANTCFG_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('tenantcfg')),
  CAP_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('cap')),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
  throw new Error(`Invalid environment variables: ${issues}`);
}

export const env = parsed.data;
