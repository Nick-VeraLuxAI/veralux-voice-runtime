#!/usr/bin/env bash
set -euo pipefail

docker compose up -d redis

echo "REDIS_URL=redis://localhost:6379"
