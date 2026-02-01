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

## No response when user hangs up right after speaking

Symptoms:
- User says something and hangs up; no assistant reply is heard.
- Logs show `late_final_captured` and `telnyx_call_control_ignored_post_end` with status 422 ("Call has already ended").

Explanation:
- STT often finalizes only when the media stream stops (e.g. on hangup). The transcript then arrives after the call has ended. We attempt playback for that "late final" transcript, but Telnyx rejects the command because the call is no longer active.

What helps:
- **Lower the silence threshold** so the runtime finalizes the utterance on a short pause *before* the user hangs up. Set `STT_SILENCE_MS` (and optionally `STT_SILENCE_END_MS`) to a smaller value (e.g. 500–700 ms). The assistant can then respond while the call is still up.
- **No-frame timeout**: If the media stream stops sending frames after the user speaks (e.g. carrier stops sending silence), the runtime now finalizes after `STT_NO_FRAME_FINALIZE_MS` (default 1000 ms) with no frames received. That sends the utterance to STT and lets the assistant respond before the call is torn down. You can lower it (e.g. 800) for faster response when the stream goes quiet.
- Encourage users to pause briefly after speaking so the system can detect end-of-utterance and respond in time.
