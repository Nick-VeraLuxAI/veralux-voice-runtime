# Configuration

Configuration is read from environment variables via `dotenv` and validated at startup in `src/env.ts`. Missing required variables cause startup to fail.

## Required environment variables

- `PORT`: HTTP listen port.
- `TELNYX_API_KEY`: API key used by the Telnyx client.
- `TELNYX_PUBLIC_KEY`: Telnyx public key for webhook signature verification.
- `MEDIA_STREAM_TOKEN`: Token required for the media WebSocket.
- `AUDIO_PUBLIC_BASE_URL`: Base URL for public audio assets.
- `AUDIO_STORAGE_DIR`: Local directory for storing wav files.
- `WHISPER_URL`: Whisper HTTP endpoint.
- `KOKORO_URL`: Kokoro HTTP endpoint.
- `STT_CHUNK_MS`: STT chunk interval in milliseconds.
- `STT_SILENCE_MS`: Silence timeout before flushing a chunk.
- `DEAD_AIR_MS`: Timeout before a reprompt.
- `REDIS_URL`: Redis connection URL.
- `GLOBAL_CONCURRENCY_CAP`: Global concurrent call limit.
- `TENANT_CONCURRENCY_CAP_DEFAULT`: Default per-tenant concurrent limit.
- `TENANT_CALLS_PER_MIN_CAP_DEFAULT`: Default per-tenant RPM limit.
- `CAPACITY_TTL_SECONDS`: TTL for active call tracking keys.

## Optional environment variables

- `TENANTMAP_PREFIX` (default `tenantmap`): Redis prefix for DID and cap override keys.
- `TENANTCFG_PREFIX` (default `tenantcfg`): Redis prefix for tenant config.
- `CAP_PREFIX` (default `cap`): Redis prefix for capacity tracking keys.
- `AUDIO_CLEANUP_HOURS` (default `24`): Max age before local audio cleanup.
- `TELNYX_WEBHOOK_SECRET`: HMAC secret for webhook verification when using HMAC.
- `LOG_LEVEL` (default `info`): Logging verbosity.

## Tenant configuration in Redis (tenantcfg v1)

Tenant config is loaded from Redis at `${TENANTCFG_PREFIX}:${tenantId}` and validated against the v1 schema. Required fields include:

- `contractVersion` (must be `"v1"`)
- `tenantId`
- `dids` (E.164 strings)
- `caps`, `stt`, `tts`, `audio`
- `webhookSecretRef` or `webhookSecret`

## DID mapping in Redis

To map a DID to a tenant:

```bash
redis-cli set tenantmap:did:+15551234567 tenant-1
```

DIDs are normalized to E.164 (`/^\+[1-9]\d{1,14}$/`). Invalid numbers are treated as missing.

## Example .env

```bash
PORT=3000
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
MEDIA_STREAM_TOKEN=devtoken
AUDIO_PUBLIC_BASE_URL=https://media.example.com/audio
AUDIO_STORAGE_DIR=/var/lib/voice/audio
WHISPER_URL=https://stt.example.com/v1/whisper
KOKORO_URL=https://tts.example.com/v1/kokoro
STT_CHUNK_MS=800
STT_SILENCE_MS=1200
DEAD_AIR_MS=15000
REDIS_URL=redis://localhost:6379
GLOBAL_CONCURRENCY_CAP=200
TENANT_CONCURRENCY_CAP_DEFAULT=10
TENANT_CALLS_PER_MIN_CAP_DEFAULT=120
CAPACITY_TTL_SECONDS=60
TENANTMAP_PREFIX=tenantmap
TENANTCFG_PREFIX=tenantcfg
CAP_PREFIX=cap
AUDIO_CLEANUP_HOURS=24
TELNYX_WEBHOOK_SECRET=devsecret
LOG_LEVEL=info
```
