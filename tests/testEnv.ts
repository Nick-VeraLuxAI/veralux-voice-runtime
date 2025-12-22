const defaults: Record<string, string> = {
  PORT: '3000',
  TELNYX_API_KEY: 'test',
  TELNYX_PUBLIC_KEY: 'test',
  MEDIA_STREAM_TOKEN: 'test',
  AUDIO_PUBLIC_BASE_URL: 'http://localhost/audio',
  AUDIO_STORAGE_DIR: '/tmp/audio',
  WHISPER_URL: 'http://localhost/whisper',
  KOKORO_URL: 'http://localhost/kokoro',
  STT_CHUNK_MS: '1000',
  STT_SILENCE_MS: '500',
  DEAD_AIR_MS: '2000',
  REDIS_URL: 'redis://localhost:6379',
  GLOBAL_CONCURRENCY_CAP: '30',
  TENANT_CONCURRENCY_CAP_DEFAULT: '5',
  TENANT_CALLS_PER_MIN_CAP_DEFAULT: '10',
  CAPACITY_TTL_SECONDS: '600',
  TENANTMAP_PREFIX: 'tenantmap',
  CAP_PREFIX: 'cap',
};

export function setTestEnv(): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
