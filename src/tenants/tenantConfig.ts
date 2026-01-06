import { z } from 'zod';
import { env } from '../env';
import { log } from '../log';
import { getRedisClient, RedisClient } from '../redis/client';

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const BaseRuntimeTenantConfigSchema = z
  .object({
    contractVersion: z.literal('v1'),
    tenantId: z.string().min(1),
    dids: z.array(z.string().regex(E164_REGEX, 'invalid E.164 DID')).min(1),
    webhookSecretRef: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
    caps: z.object({
      maxConcurrentCallsTenant: z.number().int().positive(),
      maxCallsPerMinuteTenant: z.number().int().positive(),
      maxConcurrentCallsGlobal: z.number().int().positive().optional(),
    }),
    stt: z.object({
      mode: z.enum(['whisper_http', 'disabled', 'http_wav_json']),
      whisperUrl: z.string().min(1).optional(),
      chunkMs: z.number().int().positive(),
      language: z.string().min(1).optional(),
      config: z
        .object({
          url: z.string().min(1).optional(),
        })
        .optional(),
    }),
    tts: z.object({
      mode: z.literal('kokoro_http'),
      kokoroUrl: z.string().min(1),
      voice: z.string().min(1).optional(),
      format: z.string().min(1).optional(),
      sampleRate: z.number().int().positive().optional(),
    }),
    audio: z.object({
      publicBaseUrl: z.string().min(1).optional(),
      storageDir: z.string().min(1).optional(),
      runtimeManaged: z.boolean().optional(),
    }),
  })
  .passthrough();

const RuntimeTenantConfigSchema = BaseRuntimeTenantConfigSchema.superRefine((value, ctx) => {
  if (!value.webhookSecretRef && !value.webhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'webhookSecretRef or webhookSecret is required',
      path: ['webhookSecretRef'],
    });
  }
});

export type RuntimeTenantConfig = z.infer<typeof RuntimeTenantConfigSchema>;

export function buildTenantConfigKey(tenantId: string): string {
  return `${env.TENANTCFG_PREFIX}:${tenantId}`;
}

export async function loadTenantConfig(
  tenantId: string,
  redis: RedisClient = getRedisClient(),
): Promise<RuntimeTenantConfig | null> {
  const key = buildTenantConfigKey(tenantId);
  let raw: string | null;

  try {
    raw = await redis.get(key);
  } catch (error) {
    log.error({ err: error, tenant_id: tenantId, key }, 'tenant config fetch failed');
    return null;
  }

  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error({ err: error, tenant_id: tenantId, key }, 'tenant config json parse failed');
    return null;
  }

  const result = RuntimeTenantConfigSchema.safeParse(parsed);
  if (!result.success) {
    log.error({ tenant_id: tenantId, key, issues: result.error.issues }, 'tenant config invalid');
    return null;
  }

  return result.data;
}

export { RuntimeTenantConfigSchema };