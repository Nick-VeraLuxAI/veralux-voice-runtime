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
STORAGE_IN="${BASE_DIR}/runtime_selected_storage.awb"
RAW_IN="${BASE_DIR}/raw_frames.bin"

OCTET_OUT="${BASE_DIR}/octet_aligned.wav"
STORAGE_OUT="${BASE_DIR}/runtime_selected_storage.wav"
RAW_OUT="${BASE_DIR}/raw_frames_guess.wav"

if [[ -f "$OCTET_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$OCTET_IN" "$OCTET_OUT"
fi

if [[ -f "$STORAGE_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$STORAGE_IN" "$STORAGE_OUT"
fi

if [[ -f "$RAW_IN" ]]; then
  ffmpeg -hide_banner -loglevel error -y -f amrwb -i "$RAW_IN" "$RAW_OUT"
fi

echo "octet_aligned.wav: $OCTET_OUT"
echo "runtime_selected_storage.wav: $STORAGE_OUT"
echo "raw_frames_guess.wav: $RAW_OUT"
