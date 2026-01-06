function ensureEnv(name: string, fallback: string): void {
  if (!process.env[name]) {
    process.env[name] = fallback;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  ensureEnv('PORT', '3000');
  ensureEnv('TELNYX_API_KEY', 'test-key');
  ensureEnv('PUBLIC_BASE_URL', 'http://localhost:3000');
  ensureEnv('TELNYX_PUBLIC_KEY', 'test-public-key');
  ensureEnv('MEDIA_STREAM_TOKEN', 'test-token');
  ensureEnv('AUDIO_PUBLIC_BASE_URL', 'http://localhost/audio');
  ensureEnv('AUDIO_STORAGE_DIR', '/tmp/voice-runtime');
  ensureEnv('WHISPER_URL', 'http://localhost/whisper');
  ensureEnv('KOKORO_URL', 'http://localhost/kokoro');
  ensureEnv('STT_CHUNK_MS', '1000');
  ensureEnv('STT_SILENCE_MS', '1000');
  ensureEnv('DEAD_AIR_MS', '1000');
  ensureEnv('REDIS_URL', 'redis://localhost:6379');
  ensureEnv('GLOBAL_CONCURRENCY_CAP', '10');
  ensureEnv('TENANT_CONCURRENCY_CAP_DEFAULT', '5');
  ensureEnv('TENANT_CALLS_PER_MIN_CAP_DEFAULT', '30');
  ensureEnv('CAPACITY_TTL_SECONDS', '60');
  ensureEnv('TENANTMAP_PREFIX', 'tenantmap');
  ensureEnv('TENANTCFG_PREFIX', 'tenantcfg');
  ensureEnv('CAP_PREFIX', 'cap');

  const { normalizeE164 } = await import('../src/tenants/tenantResolver');
  const { RuntimeTenantConfigSchema } = await import('../src/tenants/tenantConfig');

  const normalized = normalizeE164('+1 555 123 4567');
  assert(normalized === '+15551234567', 'normalizeE164 should strip spaces and preserve E.164');

  const invalid = normalizeE164('555');
  assert(invalid === '', 'normalizeE164 should return empty for invalid E.164');

  const baseConfig = {
    tenantId: 'tenant_123',
    dids: ['+14155550123'],
    webhookSecret: 'secret',
    caps: {
      maxConcurrentCallsTenant: 2,
      maxCallsPerMinuteTenant: 10,
      maxConcurrentCallsGlobal: 20,
    },
    stt: {
      mode: 'whisper_http',
      whisperUrl: 'http://localhost/whisper',
      chunkMs: 800,
    },
    tts: {
      mode: 'kokoro_http',
      kokoroUrl: 'http://localhost/kokoro',
    },
    audio: {},
  };

  const missingVersion = RuntimeTenantConfigSchema.safeParse(baseConfig);
  assert(!missingVersion.success, 'tenantcfg schema should reject missing contractVersion');

  process.stdout.write('self-check ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
