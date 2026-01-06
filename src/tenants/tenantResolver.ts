import { env } from '../env';
import { log } from '../log';
import { getRedisClient, RedisClient } from '../redis/client';

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

export function normalizeE164(toNumber: string): string {
  const normalized = toNumber.trim().replace(/\s+/g, '');
  if (!E164_REGEX.test(normalized)) {
    return '';
  }
  return normalized;
}

export async function resolveTenantId(
  toNumber: string,
  redis: RedisClient = getRedisClient(),
): Promise<string | null> {
  const normalized = normalizeE164(toNumber);
  if (!normalized) {
    log.debug({ did: toNumber }, 'invalid did');
    return null;
  }

  const key = `${env.TENANTMAP_PREFIX}:did:${normalized}`;

  try {
    const tenantId = await redis.get(key);
    return tenantId ?? null;
  } catch (error) {
    log.error({ err: error, did: normalized }, 'tenant resolve failed');
    return null;
  }
}