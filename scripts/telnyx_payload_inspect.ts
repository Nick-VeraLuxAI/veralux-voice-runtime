import fs from 'fs';

function formatHex(buffer: Buffer, length: number): string {
  return buffer.subarray(0, length).toString('hex');
}

function classifyPayload(buffer: Buffer): string {
  if (buffer.length === 0) return 'empty';

  const header = buffer.subarray(0, 9).toString('ascii');
  if (header.startsWith('#!AMR-WB')) return 'amrwb_header';

  const firstByte = buffer[0];
  const amrwbFrameStarts = new Set([0x3c, 0x3d, 0x3e, 0x3f]);
  if (amrwbFrameStarts.has(firstByte)) return 'likely_raw_amrwb_frame';

  if ((firstByte & 0xc0) === 0x80 && buffer.length >= 12) return 'looks_like_rtp';

  return 'unknown_or_corrupted';
}

const filePath = process.argv[2] ?? '/tmp/telnyx_payload_raw.bin';
if (!fs.existsSync(filePath)) {
  console.error(`file not found: ${filePath}`);
  process.exit(1);
}

const buffer = fs.readFileSync(filePath);
console.log(`file: ${filePath}`);
console.log(`bytes: ${buffer.length}`);
console.log(`first64_hex: ${formatHex(buffer, 64)}`);

const note = classifyPayload(buffer);
console.log(`note: ${note}`);

if (note === 'looks_like_rtp') {
  const version = (buffer[0] >> 6) & 0x03;
  const payloadType = buffer[1] & 0x7f;
  console.log(`rtp_version: ${version}`);
  console.log(`rtp_payload_type: ${payloadType}`);
}
