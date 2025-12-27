import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const stringToBoolean = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') {
      return undefined;
    }
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return value;
};

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  TELNYX_API_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  TELNYX_PUBLIC_KEY: z.string().min(1),
  TELNYX_STREAM_TRACK: z
    .enum(['inbound_track', 'outbound_track', 'both_tracks'])
    .default('inbound_track'),
  TELNYX_SKIP_SIGNATURE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  MEDIA_STREAM_TOKEN: z.string().min(1),
  AUDIO_PUBLIC_BASE_URL: z.string().min(1),
  AUDIO_STORAGE_DIR: z.string().min(1),
  WHISPER_URL: z.string().min(1),
  KOKORO_URL: z.string().min(1),
  KOKORO_VOICE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BRAIN_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BRAIN_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(8000),
  ),
  BRAIN_STREAMING_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  BRAIN_STREAM_PATH: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('/reply/stream'),
  ),
  BRAIN_STREAM_PING_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(15000),
  ),
  BRAIN_STREAM_FIRST_AUDIO_MAX_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(2000),
  ),
  BRAIN_STREAM_SEGMENT_MIN_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(120),
  ),
  BRAIN_STREAM_SEGMENT_NEXT_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(180),
  ),
  STT_CHUNK_MS: z.coerce.number().int().positive(),
  STT_SILENCE_MS: z.coerce.number().int().positive(),
  STT_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1.5)),
  STT_SILENCE_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1.0)),
  STT_RMS_THRESHOLD: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(350)),
  STT_SILENCE_END_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(650)),
  STT_MIN_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(400)),
  STT_MAX_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  STT_PARTIAL_EVERY_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(700)),
  STT_PRE_ROLL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(200)),
  DEAD_AIR_MS: z.coerce.number().int().positive(),
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
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  throw new Error(`Invalid environment variables: ${issues}`);
}

export const env = parsed.data;
