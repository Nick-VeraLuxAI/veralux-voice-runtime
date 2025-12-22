const WebSocket = require('ws');

const callControlId = process.env.CALL_CONTROL_ID || `call_${Date.now()}`;
const token = process.env.MEDIA_STREAM_TOKEN;
const baseUrl = process.env.MEDIA_WS_URL || `ws://localhost:3000/v1/telnyx/media/${callControlId}?token=${token}`;
const frameSize = Number.parseInt(process.env.FRAME_SIZE || '320', 10);
const frameIntervalMs = Number.parseInt(process.env.FRAME_INTERVAL_MS || '100', 10);
const totalFrames = Number.parseInt(process.env.FRAME_COUNT || '10', 10);

if (!token && !process.env.MEDIA_WS_URL) {
  console.error('MEDIA_STREAM_TOKEN is required unless MEDIA_WS_URL is provided');
  process.exit(1);
}

const ws = new WebSocket(baseUrl);

ws.on('open', () => {
  console.log(`connected: ${baseUrl}`);
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= totalFrames) {
      clearInterval(timer);
      ws.close();
      return;
    }

    const frame = Buffer.alloc(frameSize, sent % 255);
    ws.send(frame, { binary: true });
    sent += 1;
  }, frameIntervalMs);
});

ws.on('close', (code, reason) => {
  const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason);
  console.log(`closed: ${code} ${reasonText}`);
});

ws.on('error', (error) => {
  console.error('ws error', error);
});
