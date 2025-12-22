import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  TELNYX_API_KEY: z.string().min(1),
  TELNYX_PUBLIC_KEY: z.string().min(1),
  MEDIA_STREAM_TOKEN: z.string().min(1),
  AUDIO_PUBLIC_BASE_URL: z.string().min(1),
  AUDIO_STORAGE_DIR: z.string().min(1),
  WHISPER_URL: z.string().min(1),
  KOKORO_URL: z.string().min(1),
  STT_CHUNK_MS: z.coerce.number().int().positive(),
  STT_SILENCE_MS: z.coerce.number().int().positive(),
  DEAD_AIR_MS: z.coerce.number().int().positive(),
  REDIS_URL: z.string().min(1),
  GLOBAL_CONCURRENCY_CAP: z.coerce.number().int().positive(),
  TENANT_CONCURRENCY_CAP_DEFAULT: z.coerce.number().int().positive(),
  TENANT_CALLS_PER_MIN_CAP_DEFAULT: z.coerce.number().int().positive(),
  CAPACITY_TTL_SECONDS: z.coerce.number().int().positive(),
  TENANTMAP_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('tenantmap')),
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
