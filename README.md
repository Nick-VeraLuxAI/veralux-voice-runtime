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
- BRAIN_URL
- BRAIN_TIMEOUT_MS (8000)
- BRAIN_STREAMING_ENABLED (true)
- BRAIN_STREAM_PATH (/reply/stream)
- BRAIN_STREAM_PING_MS (15000)
- BRAIN_STREAM_FIRST_AUDIO_MAX_MS (2000)
- BRAIN_STREAM_SEGMENT_MIN_CHARS (120)
- BRAIN_STREAM_SEGMENT_NEXT_CHARS (180)
- TRANSPORT_MODE (pstn)
- WEBRTC_PORT (optional)
- WEBRTC_ALLOWED_ORIGINS (optional, comma-separated)
- TENANTMAP_PREFIX (tenantmap)
- CAP_PREFIX (cap)
- AUDIO_CLEANUP_HOURS (24)
- TELNYX_WEBHOOK_SECRET (for local webhook signing)
- TELNYX_INGEST_HEALTH_GRACE_MS (1200)
- TELNYX_INGEST_HEALTH_ENABLED (true)
- TELNYX_INGEST_HEALTH_RESTART_ENABLED (true)
- TELNYX_INGEST_POST_PLAYBACK_GRACE_MS (1200)
- TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END (2000)
- TELNYX_AMRWB_MIN_DECODED_BYTES (320)
- TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK (3)
- STT_PRE_ROLL_MS (1200)
- STT_PARTIAL_MIN_MS (600)
- STT_HIGHPASS_ENABLED (true)
- STT_HIGHPASS_CUTOFF_HZ (100)
- STT_DEBUG_DUMP_WHISPER_WAVS (false)
- STT_DEBUG_DUMP_PCM16 (false)

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

## Streaming (Brain SSE)

Brain:
- Start the Brain server with a POST `/reply/stream` SSE endpoint (`text/event-stream`).

Runtime (dev defaults shown):
```bash
export BRAIN_URL=http://localhost:4000
export BRAIN_STREAMING_ENABLED=true
export BRAIN_STREAM_PATH=/reply/stream
export BRAIN_STREAM_PING_MS=15000
export BRAIN_STREAM_FIRST_AUDIO_MAX_MS=2000
export BRAIN_STREAM_SEGMENT_MIN_CHARS=120
export BRAIN_STREAM_SEGMENT_NEXT_CHARS=180
```

If the stream endpoint is unavailable or does not return `text/event-stream`, the runtime falls back to `POST /reply`.

## Transport Modes

PSTN (default):
- `TRANSPORT_MODE=pstn`
- Use Telnyx Call Control + Media Streams as usual.

WebRTC HD (optional):
1) Set:
```bash
export TRANSPORT_MODE=webrtc_hd
export WEBRTC_ALLOWED_ORIGINS=http://localhost:4001
```
2) Install the optional WebRTC dependency (required for HD mode):
```bash
npm install
```
2) Ensure the tenant config exists in Redis.
3) Run the server and open:
```
http://localhost:4001/hd-call?tenant_id=tenantA
```
4) Click **Start Call** in the browser.

Notes:
- For true wideband playback, set `TTS_SAMPLE_RATE` or per-tenant `tts.sampleRate` to 24000/48000.
- PSTN remains unchanged and continues to use Telnyx webhooks.
- WebRTC endpoints are served on the main HTTP port; `WEBRTC_PORT` is reserved for future separation.
- If `wrtc` is not installed, the `/v1/webrtc/offer` endpoint returns `webrtc_init_failed`.

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
