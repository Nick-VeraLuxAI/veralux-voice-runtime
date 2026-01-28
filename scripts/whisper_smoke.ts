// scripts/whisper_smoke.ts
import fs from "node:fs";

const WHISPER_URL = process.env.WHISPER_URL ?? "http://127.0.0.1:9000/transcribe";

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error("Usage: tsx scripts/whisper_smoke.ts <file.wav>");
    process.exit(2);
  }

  const buf = fs.readFileSync(wavPath);

  const res = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: new Uint8Array(buf), // important: send bytes, not Buffer object
  });

  const text = await res.text();
  console.log("status:", res.status);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
