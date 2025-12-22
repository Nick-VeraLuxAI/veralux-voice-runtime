import { env } from '../env';
import { log } from '../log';
import { getRedisClient, RedisClient } from '../redis/client';

export function normalizeE164(toNumber: string): string {
  return toNumber.trim().replace(/\s+/g, '');
}

export async function resolveTenantId(
  toNumber: string,
  redis: RedisClient = getRedisClient(),
): Promise<string | null> {
  const normalized = normalizeE164(toNumber);
  if (!normalized) {
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
