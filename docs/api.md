# API

This runtime exposes HTTP endpoints and a WebSocket endpoint for Telnyx.

## HTTP endpoints

### GET /health

Liveness check.

Response:

```json
{ "status": "ok" }
```

### GET /metrics

Prometheus metrics endpoint.

Response:

- `200` with Prometheus text exposition (prefixed `veralux_voice_runtime_`).
- See `docs/operations.md` for metric names and labels.

### POST /v1/telnyx/webhook

Telnyx Call Control webhook endpoint.

Headers:
- `telnyx-signature-ed25519` or `telnyx-signature`
- `telnyx-timestamp`

Behavior:
- Verifies the signature and timestamp.
- Enqueues processing by `call_control_id`.
- Always responds `200 {"ok": true}` if signature is valid.
- Responds `401 {"error": "invalid_signature"}` on invalid signature.

Notes:
- Only a subset of events are acted on: `call.initiated`, `call.answered`, `call.hangup`, `call.ended`.
- Failures in async processing do not affect the HTTP response.

## WebSocket endpoint

### WS /v1/telnyx/media/{callControlId}?token=...

Media stream endpoint for Telnyx audio frames.

Requirements:
- `token` must match `MEDIA_STREAM_TOKEN`.
- `callControlId` must be a single path segment.

Behavior:
- Expects binary audio frames.
- Closes with code `1008` for invalid call control IDs or missing sessions.

## Response audio playback

The runtime uses Telnyx Call Control APIs to answer, play audio, and hang up. These requests are made server-side and are not exposed directly as public endpoints.
