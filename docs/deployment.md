# Deployment

## Prerequisites

- Node.js 18+ (for native fetch and ws).
- Redis 7+ (for tenant mapping, tenantcfg, capacity limits).
- Reachable Whisper HTTP endpoint.
- Reachable Kokoro HTTP endpoint.
- Writable local storage for audio files.

## Build and run

```bash
npm install
npm run build
npm run start
```

For development:

```bash
npm run dev
```

## Redis

A local Redis can be started via:

```bash
./scripts/dev_redis.sh
```

The provided `docker-compose.yml` starts a single Redis container.

## Scaling considerations

- Multiple runtime instances can share Redis for tenant mapping and capacity checks.
- Media WebSocket connections must land on the instance that owns the call session. Use sticky sessions or route by call control ID.
- Audio files are stored on local disk; use shared storage or per-instance media URLs if running multiple nodes.

## Networking

- Terminate TLS at a reverse proxy or load balancer.
- Allow inbound HTTPS to `/v1/telnyx/webhook` and WebSocket upgrades to `/v1/telnyx/media/...`.
- Ensure outbound access to Redis, Whisper, and Kokoro endpoints.
