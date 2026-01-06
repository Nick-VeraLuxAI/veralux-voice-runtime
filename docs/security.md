# Security

## Webhook verification

- Telnyx signatures are verified using `TELNYX_PUBLIC_KEY` (ed25519) or `TELNYX_WEBHOOK_SECRET` (HMAC).
- Requests with invalid signatures are rejected with 401.
- Tenantcfg includes webhook secrets, but the runtime does not yet use them for per-tenant verification.

## Media WebSocket access

- Media streaming requires the `MEDIA_STREAM_TOKEN` query param.
- Invalid tokens result in connection closure.

## Secrets management

- Store secrets in environment variables or a secret manager.
- Avoid committing `.env` to version control.

## Network security

- Terminate TLS at a proxy or load balancer.
- Restrict inbound access to the webhook and media endpoints.
- Restrict Redis access to trusted networks.

## Data handling

- Audio is stored on local disk; ensure filesystem and backups are protected.
- Logs may include call identifiers and tenant IDs; review logging policy before production.
