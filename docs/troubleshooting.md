# Troubleshooting

## Invalid signature (401)

Symptoms:
- Webhook returns 401 `invalid_signature`.

Checks:
- Ensure `TELNYX_PUBLIC_KEY` or `TELNYX_WEBHOOK_SECRET` is correct.
- Confirm Telnyx is sending `telnyx-timestamp` and signature headers.
- Verify system clock skew is within 5 minutes.

## "The number you dialed is not configured."

Symptoms:
- Call is answered and immediately hangs up with the message.

Checks:
- Confirm DID is in E.164 format.
- Ensure Redis has a mapping at `${TENANTMAP_PREFIX}:did:${e164}`.

## "This number is not fully configured."

Symptoms:
- Call is answered and hangs up with the message.

Checks:
- Confirm tenantcfg exists at `${TENANTCFG_PREFIX}:${tenantId}`.
- Validate tenantcfg v1 schema (contractVersion, required fields, E.164 DIDs).

## Capacity errors

Symptoms:
- "We are currently at capacity" or "unable to accept your call".

Checks:
- Inspect Redis capacity keys and overrides.
- Confirm tenantcfg caps are reasonable.
- Look for `capacity_denied` or `capacity_eval_failed` logs.

## STT or TTS failures

Symptoms:
- No transcription or TTS playback errors.

Checks:
- Validate `WHISPER_URL` or tenantcfg `stt.whisperUrl`.
- Validate `KOKORO_URL` or tenantcfg `tts.kokoroUrl`.
- Check network connectivity from the runtime host.

## Media WebSocket disconnects

Symptoms:
- WebSocket closes with code 1008 or no audio ingestion.

Checks:
- Confirm `MEDIA_STREAM_TOKEN` matches the query param.
- Ensure the call session exists before media connects.
