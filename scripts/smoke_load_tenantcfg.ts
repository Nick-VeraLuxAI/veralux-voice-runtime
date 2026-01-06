import { env } from '../src/env';
import { createRedisClient } from '../src/redis/client';
import { buildTenantConfigKey, loadTenantConfig, RuntimeTenantConfig } from '../src/tenants/tenantConfig';

async function main(): Promise<void> {
  const tenantId = `smoke_${Date.now()}`;
  const sampleConfig: RuntimeTenantConfig = {
    contractVersion: 'v1',
    tenantId,
    dids: ['+14155550123'],
    webhookSecret: 'smoke-webhook-secret',
    caps: {
      maxConcurrentCallsTenant: 5,
      maxCallsPerMinuteTenant: 30,
      maxConcurrentCallsGlobal: 100,
    },
    stt: {
      mode: 'whisper_http',
      whisperUrl: env.WHISPER_URL,
      chunkMs: env.STT_CHUNK_MS,
      language: 'en',
    },
    tts: {
      mode: 'kokoro_http',
      kokoroUrl: env.KOKORO_URL,
      voice: 'alloy',
      format: 'wav',
      sampleRate: 24000,
    },
    audio: {
      publicBaseUrl: env.AUDIO_PUBLIC_BASE_URL,
      storageDir: env.AUDIO_STORAGE_DIR,
      runtimeManaged: true,
    },
  };

  const redis = createRedisClient();
  const key = buildTenantConfigKey(tenantId);

  try {
    await redis.set(key, JSON.stringify(sampleConfig));
    const loaded = await loadTenantConfig(tenantId, redis);
    if (!loaded) {
      throw new Error('tenantcfg smoke test failed: config did not load');
    }
    if (loaded.contractVersion !== 'v1' || loaded.tenantId !== tenantId) {
      throw new Error('tenantcfg smoke test failed: loaded config mismatch');
    }
    process.stdout.write('tenantcfg smoke test ok\n');
  } finally {
    await redis.del(key);
    await redis.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
