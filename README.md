# Veralux Voice Runtime

Production-grade TypeScript runtime for Telnyx call control with real-time media ingest, STT, and TTS.

## Environment Variables

Required:
- PORT
- TELNYX_API_KEY
- TELNYX_PUBLIC_KEY
- MEDIA_STREAM_TOKEN
- AUDIO_PUBLIC_BASE_URL
- AUDIO_STORAGE_DIR
- WHISPER_URL
- KOKORO_URL
- STT_CHUNK_MS
- STT_SILENCE_MS
- DEAD_AIR_MS
- REDIS_URL
- GLOBAL_CONCURRENCY_CAP
- TENANT_CONCURRENCY_CAP_DEFAULT
- TENANT_CALLS_PER_MIN_CAP_DEFAULT
- CAPACITY_TTL_SECONDS

Optional (defaults shown):
- TENANTMAP_PREFIX (tenantmap)
- CAP_PREFIX (cap)
- AUDIO_CLEANUP_HOURS (24)
- TELNYX_WEBHOOK_SECRET (for local webhook signing)

## Run Locally

1) Install deps:

```bash
npm install
```

2) Start Redis (optional for local mapping/caps):

```bash
./scripts/dev_redis.sh
```

3) Run the server:

```bash
npm run dev
```

## Test Webhooks

1) Set a local webhook signing secret for the verifier and exporter:

```bash
export TELNYX_WEBHOOK_SECRET=devsecret
```

2) Optional: map your test DID to a tenant in Redis:

```bash
redis-cli set tenantmap:did:+15551234567 tenant-1
```

3) Send sample call events:

```bash
export WEBHOOK_URL=http://localhost:3000/v1/telnyx/webhook
./scripts/smoke_webhook.sh
```

If the DID is not mapped, the runtime will answer with a "not configured" message and hang up.

## Test Media WebSocket

1) Ensure a session exists (send call.initiated with the same call_control_id).

2) Send fake audio frames:

```bash
export MEDIA_STREAM_TOKEN=devtoken
export CALL_CONTROL_ID=call_123
node scripts/smoke_media_ws.js
```

To use an ngrok tunnel:

```bash
./scripts/dev_ngrok.sh
```

Use the printed `MEDIA_WS_URL` (replace `{callControlId}` and `MEDIA_STREAM_TOKEN`).
