# Operations

## Health checks

- `GET /health` returns `200 {"status":"ok"}` when the process is alive.

## Metrics

- `GET /metrics` exposes Prometheus metrics (text format) with prefix `veralux_voice_runtime_`.
- Durations are recorded in true milliseconds (ms); route labels normalize IDs to reduce cardinality.
- Runtime metrics:
  - `veralux_voice_runtime_http_request_duration_ms` (Histogram) labeled by `method`, `route`, `code`.
  - `veralux_voice_runtime_stage_duration_ms` (Histogram) labeled by `stage`, `tenant` with stages:
    - `pre_stt_gate`, `stt`, `llm`, `tts`, `telnyx_playback`
  - `veralux_voice_runtime_stage_errors_total` (Counter) labeled by `stage`, `tenant`.
- Default Node.js/process metrics from prom-client are exported with the same prefix (CPU, memory, event loop, GC, etc).

## Logs

- Logging uses pino with `LOG_LEVEL` (default `info`).
- Key events include capacity acquisition/denial, session lifecycle, and STT/TTS errors.
- Call lifecycle logs include metrics like `session_duration_ms`, `turns`, and `last_heard_at` on `call_session_teardown`.
- Stage-oriented logs include `duration_ms` on events like `stt_chunk_transcribed`, `brain_stream_done`, and Telnyx call control completions.

## Capacity management

- Capacity limits are enforced with a Redis Lua script.
- Per-tenant defaults come from tenantcfg caps; overrides can be set in Redis:
  - `${TENANTMAP_PREFIX}:tenant:${tenantId}:cap:concurrency`
  - `${TENANTMAP_PREFIX}:tenant:${tenantId}:cap:rpm`

## Audio storage cleanup

- Local audio files are cleaned up periodically.
- `AUDIO_CLEANUP_HOURS` controls max age before deletion (default 24 hours).

## Runbook basics

- Verify Redis connectivity on startup.
- Confirm tenant DID mapping and tenantcfg exist for the target DID.
- Check logs for `capacity_denied`, `tenant resolve failed`, and `tenant config invalid`.
- Validate Whisper and Kokoro endpoints from the runtime host.
