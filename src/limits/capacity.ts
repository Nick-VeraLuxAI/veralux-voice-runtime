import { env } from '../env';
import { log } from '../log';
import { getRedisClient, RedisClient } from '../redis/client';

const LUA_CAPACITY_SCRIPT = `
local globalKey = KEYS[1]
local tenantKey = KEYS[2]
local rpmKey = KEYS[3]
local tenantConcurrencyKey = KEYS[4]
local tenantRpmKey = KEYS[5]

local callControlId = ARGV[1]
local globalCap = tonumber(ARGV[2])
local tenantCapDefault = tonumber(ARGV[3])
local tenantRpmDefault = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

local function readCap(key, fallback)
  local value = redis.call('GET', key)
  if value then
    local parsed = tonumber(value)
    if parsed and parsed > 0 then
      return parsed
    end
  end
  return fallback
end

local tenantCap = readCap(tenantConcurrencyKey, tenantCapDefault)
local tenantRpmCap = readCap(tenantRpmKey, tenantRpmDefault)

local inGlobal = redis.call('SISMEMBER', globalKey, callControlId)
local inTenant = redis.call('SISMEMBER', tenantKey, callControlId)
if inGlobal == 1 or inTenant == 1 then
  redis.call('SADD', globalKey, callControlId)
  redis.call('SADD', tenantKey, callControlId)
  redis.call('EXPIRE', globalKey, ttlSeconds)
  redis.call('EXPIRE', tenantKey, ttlSeconds)
  return 'OK'
end

local globalCount = redis.call('SCARD', globalKey)
if globalCount >= globalCap then
  return 'global_at_capacity'
end

local tenantCount = redis.call('SCARD', tenantKey)
if tenantCount >= tenantCap then
  return 'tenant_at_capacity'
end

local rpmCount = tonumber(redis.call('GET', rpmKey) or '0')
if rpmCount >= tenantRpmCap then
  return 'tenant_rate_limited'
end

redis.call('SADD', globalKey, callControlId)
redis.call('SADD', tenantKey, callControlId)
redis.call('EXPIRE', globalKey, ttlSeconds)
redis.call('EXPIRE', tenantKey, ttlSeconds)
local nextCount = redis.call('INCR', rpmKey)
if nextCount == 1 then
  redis.call('EXPIRE', rpmKey, 120)
end

return 'OK'
`;

const FAILURE_REASONS = ['global_at_capacity', 'tenant_at_capacity', 'tenant_rate_limited'] as const;
export type CapacityFailureReason = (typeof FAILURE_REASONS)[number];

export interface CapacityParams {
  tenantId: string;
  callControlId: string;
  nowEpochMs?: number;
  requestId?: string;
  redis?: RedisClient;
  capDefaults?: CapacityDefaults;
}

export interface ReleaseParams {
  tenantId: string;
  callControlId: string;
  requestId?: string;
  redis?: RedisClient;
}

export interface CapacityDefaults {
  globalConcurrency?: number;
  tenantConcurrency?: number;
  tenantRpm?: number;
}

let scriptSha: string | null = null;

function formatMinuteKey(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}`;
}

export function buildCapacityKeys(tenantId: string, epochMs: number): {
  globalActiveKey: string;
  tenantActiveKey: string;
  tenantRpmKey: string;
  tenantConcurrencyCapKey: string;
  tenantRpmCapKey: string;
} {
  return {
    globalActiveKey: `${env.CAP_PREFIX}:global:active`,
    tenantActiveKey: `${env.CAP_PREFIX}:tenant:${tenantId}:active`,
    tenantRpmKey: `${env.CAP_PREFIX}:tenant:${tenantId}:rpm:${formatMinuteKey(epochMs)}`,
    tenantConcurrencyCapKey: `${env.TENANTMAP_PREFIX}:tenant:${tenantId}:cap:concurrency`,
    tenantRpmCapKey: `${env.TENANTMAP_PREFIX}:tenant:${tenantId}:cap:rpm`,
  };
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.toUpperCase().includes('NOSCRIPT');
}

async function evalCapacityScript(
  redis: RedisClient,
  keys: string[],
  args: string[],
): Promise<string> {
  const numKeys = keys.length;

  if (scriptSha) {
    try {
      return (await redis.evalsha(scriptSha, numKeys, ...keys, ...args)) as string;
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }
    }
  }

  try {
    const loadedSha = String(await redis.script('LOAD', LUA_CAPACITY_SCRIPT));
    scriptSha = loadedSha;
    return (await redis.evalsha(loadedSha, numKeys, ...keys, ...args)) as string;
  } catch (error) {
    return (await redis.eval(LUA_CAPACITY_SCRIPT, numKeys, ...keys, ...args)) as string;
  }
}

export async function tryAcquire(
  params: CapacityParams,
): Promise<{ ok: true } | { ok: false; reason: CapacityFailureReason }> {
  const redis = params.redis ?? getRedisClient();
  const nowEpochMs = params.nowEpochMs ?? Date.now();
  const keys = buildCapacityKeys(params.tenantId, nowEpochMs);
  const capDefaults = params.capDefaults;
  const args = [
    params.callControlId,
    (capDefaults?.globalConcurrency ?? env.GLOBAL_CONCURRENCY_CAP).toString(),
    (capDefaults?.tenantConcurrency ?? env.TENANT_CONCURRENCY_CAP_DEFAULT).toString(),
    (capDefaults?.tenantRpm ?? env.TENANT_CALLS_PER_MIN_CAP_DEFAULT).toString(),
    env.CAPACITY_TTL_SECONDS.toString(),
  ];

  let result: string;
  try {
    result = await evalCapacityScript(redis, [
      keys.globalActiveKey,
      keys.tenantActiveKey,
      keys.tenantRpmKey,
      keys.tenantConcurrencyCapKey,
      keys.tenantRpmCapKey,
    ], args);
  } catch (error) {
    log.error(
      {
        err: error,
        event: 'capacity_eval_failed',
        tenant_id: params.tenantId,
        call_control_id: params.callControlId,
        requestId: params.requestId,
      },
      'capacity evaluation failed',
    );
    throw error;
  }

  if (result === 'OK') {
    log.info(
      {
        event: 'capacity_acquired',
        tenant_id: params.tenantId,
        call_control_id: params.callControlId,
        requestId: params.requestId,
      },
      'capacity acquired',
    );
    return { ok: true };
  }

  if (FAILURE_REASONS.includes(result as CapacityFailureReason)) {
    log.warn(
      {
        event: 'capacity_denied',
        reason: result,
        tenant_id: params.tenantId,
        call_control_id: params.callControlId,
        requestId: params.requestId,
      },
      'capacity denied',
    );
    return { ok: false, reason: result as CapacityFailureReason };
  }

  log.error(
    {
      event: 'capacity_unknown_result',
      result,
      tenant_id: params.tenantId,
      call_control_id: params.callControlId,
      requestId: params.requestId,
    },
    'capacity returned unknown result',
  );
  return { ok: false, reason: 'tenant_rate_limited' };
}

export async function release(params: ReleaseParams): Promise<void> {
  const redis = params.redis ?? getRedisClient();
  const keys = buildCapacityKeys(params.tenantId, Date.now());

  try {
    const [removedGlobal, removedTenant] = await Promise.all([
      redis.srem(keys.globalActiveKey, params.callControlId),
      redis.srem(keys.tenantActiveKey, params.callControlId),
    ]);

    log.info(
      {
        event: 'capacity_released',
        tenant_id: params.tenantId,
        call_control_id: params.callControlId,
        removed_global: removedGlobal,
        removed_tenant: removedTenant,
        requestId: params.requestId,
      },
      'capacity released',
    );
  } catch (error) {
    log.error(
      {
        event: 'capacity_release_failed',
        err: error,
        tenant_id: params.tenantId,
        call_control_id: params.callControlId,
        requestId: params.requestId,
      },
      'capacity release failed',
    );
  }
}