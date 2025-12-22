#!/usr/bin/env bash
set -euo pipefail

NGROK_API_URL="${NGROK_API_URL:-http://localhost:4040/api/tunnels}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to parse ngrok output" >&2
  exit 1
fi

response="$(curl -sS "$NGROK_API_URL" || true)"
if [[ -z "$response" ]]; then
  echo "ngrok not running or no tunnels found at $NGROK_API_URL" >&2
  exit 1
fi

public_url="$(printf '%s' "$response" | node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));const url=(data.tunnels||[]).map(t=>t.public_url).find(Boolean);if(!url){process.exit(1);}console.log(url);")" || true

if [[ -z "$public_url" ]]; then
  echo "no public_url found in ngrok response" >&2
  exit 1
fi

base="${public_url%/}"

printf 'WEBHOOK_URL=%s/v1/telnyx/webhook\n' "$base"
printf 'MEDIA_WS_URL=%s/v1/telnyx/media/{callControlId}?token=MEDIA_STREAM_TOKEN\n' "$base"
