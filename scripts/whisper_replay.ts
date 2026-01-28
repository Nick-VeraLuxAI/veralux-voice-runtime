import fs from 'fs/promises';

type Args = {
  file?: string;
  url?: string;
  language?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--file') {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--file=')) {
      args.file = arg.slice('--file='.length);
      continue;
    }
    if (arg === '--url') {
      args.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--url=')) {
      args.url = arg.slice('--url='.length);
      continue;
    }
    if (arg === '--language') {
      args.language = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--language=')) {
      args.language = arg.slice('--language='.length);
    }
  }
  return args;
}

function buildWhisperUrl(baseUrl: string, language?: string): string {
  if (!language) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}language=${encodeURIComponent(language)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.file;
  if (!filePath) {
    console.error('Usage: tsx scripts/whisper_replay.ts --file /path/to.wav [--url URL] [--language en]');
    process.exit(1);
  }

  const baseUrl = args.url ?? process.env.WHISPER_URL;
  if (!baseUrl) {
    console.error('WHISPER_URL is not set and --url was not provided.');
    process.exit(1);
  }

  const whisperUrl = buildWhisperUrl(baseUrl, args.language);
  const wav = await fs.readFile(filePath);

  const response = await fetch(whisperUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const bodyText = await response.text();

  if (!response.ok) {
    console.error(`Whisper error ${response.status}: ${bodyText}`);
    process.exit(1);
  }

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(bodyText);
      console.log(JSON.stringify(parsed, null, 2));
      return;
    } catch {
      console.log(bodyText);
      return;
    }
  }

  console.log(bodyText);
}

void main();
