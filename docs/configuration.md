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
- `STT_SILENCE_MS`: Silence timeout before flushing a chunk. Lower values (e.g. 500–700 ms) finalize utterances sooner so the assistant can respond before the user hangs up; higher values wait for longer pauses.
- `STT_NO_FRAME_FINALIZE_MS` (default `1000`): If no audio frames are received for this many ms while in speech, the utterance is finalized (so the assistant can respond even when the stream goes quiet before disconnect). Clamped 400–5000 ms.
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
- `STT_PRE_ROLL_MS` (default `1200`): Pre-roll buffer length (ms) prepended to each utterance.
- `STT_AEC_ENABLED` (default `false`): Enable SpeexDSP acoustic echo cancellation. Requires libspeexdsp: `brew install speexdsp` (macOS) or `apt install libspeexdsp-dev` (Linux). Uses the far-end reference from Tier 3 to suppress assistant playback in mic capture.

### Tier 5: Production hardening

- `STT_NOISE_FLOOR_ENABLED` (default `true`): Estimate ambient noise floor from pre-speech frames and adapt RMS/peak thresholds dynamically.
- `STT_NOISE_FLOOR_ALPHA` (default `0.05`): Exponential smoothing factor for noise floor estimation.
- `STT_NOISE_FLOOR_MIN_SAMPLES` (default `30`): Minimum frames before using adaptive thresholds.
- `STT_ADAPTIVE_RMS_MULTIPLIER` (default `2.0`): Speech RMS floor = noise_floor × multiplier.
- `STT_ADAPTIVE_PEAK_MULTIPLIER` (default `2.5`): Speech peak floor = noise_floor × multiplier.
- `STT_ADAPTIVE_FLOOR_MIN_RMS` (default `0.01`): Minimum RMS floor regardless of noise.
- `STT_ADAPTIVE_FLOOR_MIN_PEAK` (default `0.03`): Minimum peak floor regardless of noise.
- `STT_LATE_FINAL_WATCHDOG_ENABLED` (default `true`): Force finalization if speech has been ongoing for too long without silence-based finalize.
- `STT_LATE_FINAL_WATCHDOG_MS` (default `8000`): Max ms of continuous speech before watchdog forces final.

Per-call metrics are logged at teardown (`call_session_teardown`) and recorded to Prometheus: `call_completions_total`, `call_duration_seconds`, `call_turns`, `call_empty_transcript_pct`.

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
STT_PRE_ROLL_MS=1200
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
