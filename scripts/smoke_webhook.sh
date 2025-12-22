#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/v1/telnyx/webhook}"
TELNYX_WEBHOOK_SECRET="${TELNYX_WEBHOOK_SECRET:-}"
CALL_CONTROL_ID="${CALL_CONTROL_ID:-call_$(date +%s)}"
TO_NUMBER="${TO_NUMBER:-+15551234567}"
FROM_NUMBER="${FROM_NUMBER:-+15550001111}"

if [[ -z "$TELNYX_WEBHOOK_SECRET" ]]; then
  echo "TELNYX_WEBHOOK_SECRET is required to sign the payload" >&2
  exit 1
fi

sign_and_post() {
  local payload="$1"
  local timestamp
  timestamp="$(date +%s)"
  local signature
  signature="$(printf '%s' "${timestamp}.${payload}" | openssl dgst -sha256 -hmac "$TELNYX_WEBHOOK_SECRET" -binary | base64)"

  curl -sS -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -H "telnyx-timestamp: $timestamp" \
    -H "telnyx-signature: $signature" \
    --data-binary "$payload"
  echo
}

initiated_payload=$(cat <<JSON
{"data":{"event_type":"call.initiated","payload":{"call_control_id":"$CALL_CONTROL_ID","from":"$FROM_NUMBER","to":"$TO_NUMBER"}}}
JSON
)

answered_payload=$(cat <<JSON
{"data":{"event_type":"call.answered","payload":{"call_control_id":"$CALL_CONTROL_ID"}}}
JSON
)

hangup_payload=$(cat <<JSON
{"data":{"event_type":"call.hangup","payload":{"call_control_id":"$CALL_CONTROL_ID"}}}
JSON
)

echo "POST call.initiated"
sign_and_post "$initiated_payload"

sleep 0.5

echo "POST call.answered"
sign_and_post "$answered_payload"

sleep 0.5

echo "POST call.hangup"
sign_and_post "$hangup_payload"
