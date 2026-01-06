# Architecture

## Components

- HTTP server (Express)
  - `/v1/telnyx/webhook` for Telnyx call control events
  - `/health` for liveness checks
- Media WebSocket server
  - `/v1/telnyx/media/{callControlId}?token=...`
  - Receives binary audio frames from Telnyx
- Session manager
  - Creates and manages call sessions
  - Serializes work per call control ID
  - Releases capacity on teardown
- STT pipeline
  - Buffers audio and sends chunks to Whisper HTTP
  - Uses tenantcfg overrides for `whisperUrl` and `chunkMs`
- TTS pipeline
  - Sends text to Kokoro HTTP
  - Uses tenantcfg overrides for `kokoroUrl`, `voice`, `format`, `sampleRate`
- Audio storage
  - Writes wav files to local disk and returns public URLs
  - Periodic cleanup based on `AUDIO_CLEANUP_HOURS`
- Redis
  - DID to tenant mapping
  - Tenant runtime config (tenantcfg v1)
  - Capacity script and cap override keys

## Data flow

1. Webhook verification
   - Telnyx sends signed webhook events.
   - Runtime validates signature using `TELNYX_PUBLIC_KEY` or `TELNYX_WEBHOOK_SECRET`.

2. Tenant resolution
   - Extracts the destination DID and normalizes to E.164.
   - Looks up tenant ID in Redis.
   - If missing or invalid, plays a "not configured" message and hangs up.

3. Tenant config loading
   - Loads `tenantcfg:<tenantId>` from Redis.
   - Validates schema v1 with required contractVersion and E.164 DIDs.
   - If missing/invalid, plays "not fully configured" and hangs up.

4. Capacity enforcement
   - Evaluates a Lua script to enforce global and tenant caps.
   - Uses tenantcfg caps as defaults; Redis override keys still win.

5. Call session
   - Answers the call and starts a session.
   - Telnyx connects to the media WebSocket and streams audio.
   - STT produces transcripts which drive responses.
   - TTS generates audio and Telnyx plays it back.

## Concurrency model

- Per-call work is serialized in `SessionManager.enqueue`.
- Webhooks are acknowledged immediately with 200 and processed asynchronously.
- Redis capacity checks are performed per call initiation.

## Failure handling

- Missing DID mapping or tenantcfg: respond with a TTS message and hang up.
- Capacity denial: respond with a TTS message and hang up.
- Redis failures: log errors and treat as missing mapping/config.
- STT/TTS errors: logged; call continues unless already ended.
