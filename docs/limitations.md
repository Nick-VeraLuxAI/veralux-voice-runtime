# Limitations

- Tenantcfg webhook secrets are validated by schema but not used for per-tenant webhook verification.
- Audio storage is local disk only; there is no built-in object storage support.
- Media WebSocket requires sticky routing when running multiple instances.
- No distributed tracing beyond structured logs; metrics are limited to Prometheus `/metrics`.
- No caching for tenantcfg; it is fetched from Redis on call initiation.
- STT and TTS integrations are limited to Whisper HTTP and Kokoro HTTP modes.
- Health endpoint does not verify dependencies (Redis, STT, TTS).
