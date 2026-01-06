# Overview

Veralux Voice Runtime is a TypeScript service that handles Telnyx call control webhooks, streams live call audio over WebSocket, and performs real-time speech-to-text (STT) and text-to-speech (TTS). It uses Redis for tenant mapping, tenant configuration, and capacity enforcement.

## Key features

- Telnyx webhook processing for call lifecycle events.
- Media WebSocket ingestion for live audio frames.
- Chunked STT via Whisper HTTP and TTS via Kokoro HTTP.
- Per-tenant runtime config loaded from Redis (tenantcfg v1).
- Capacity limits with Redis Lua scripts and override keys.
- Prometheus metrics endpoint (`/metrics`) with HTTP and stage timing.
- Local audio storage and public URL publishing for playback.

## High-level flow

1. Telnyx posts a webhook event to `/v1/telnyx/webhook`.
2. The runtime verifies the signature and enqueues work per call control ID.
3. On call initiation, it resolves the tenant via DID mapping in Redis.
4. It loads the tenantcfg v1 config from Redis.
5. It checks capacity via Redis (global and tenant caps).
6. It creates a call session and answers the call.
7. Telnyx connects to the media WebSocket and streams audio frames.
8. The runtime transcribes and responds using STT and TTS.

## Redis usage

- DID to tenant mapping: `${TENANTMAP_PREFIX}:did:${e164}`
- Tenant runtime config: `${TENANTCFG_PREFIX}:${tenantId}`
- Capacity keys under `${CAP_PREFIX}` and cap override keys under `${TENANTMAP_PREFIX}`

See `docs/redis_contract_report.md` for key formats and failure behaviors.
