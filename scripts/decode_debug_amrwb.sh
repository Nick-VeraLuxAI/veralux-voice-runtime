#!/usr/bin/env bash
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 1
fi

CALL_ID="${1:-}"
if [[ -z "$CALL_ID" ]]; then
  echo "Usage: $0 <callId>" >&2
  exit 1
fi

BASE_DIR="/tmp/veralux-stt-debug/${CALL_ID}"
OCTET_IN="${BASE_DIR}/octet_aligned.awb"
BE_IN="${BASE_DIR}/be_converted.awb"
RAW_IN="${BASE_DIR}/raw_frames.bin"

OCTET_OUT="${BASE_DIR}/octet_aligned.wav"
BE_OUT="${BASE_DIR}/be_converted.wav"
RAW_OUT="${BASE_DIR}/raw_frames_guess.wav"

if [[ -f "$OCTET_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$OCTET_IN" "$OCTET_OUT"
fi

if [[ -f "$BE_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$BE_IN" "$BE_OUT"
fi

if [[ -f "$RAW_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$RAW_IN" "$RAW_OUT"
fi

echo "octet_aligned.wav: $OCTET_OUT"
echo "be_converted.wav:  $BE_OUT"
echo "raw_frames_guess.wav: $RAW_OUT"
