import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../env';
import { log } from '../log';
import { AudioAsset, SaveAudioInput } from './types';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 24;

let cleanupTimer: NodeJS.Timeout | undefined;
let cleanupInProgress = false;

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function getMaxAgeMs(): number {
  const parsed = Number.parseInt(process.env.AUDIO_CLEANUP_HOURS ?? '', 10);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
  return hours * 60 * 60 * 1000;
}

function ensureCleanupScheduled(): void {
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(() => {
    void cleanupOldFiles();
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

async function cleanupOldFiles(): Promise<void> {
  if (cleanupInProgress) {
    return;
  }

  cleanupInProgress = true;
  try {
    const maxAgeMs = getMaxAgeMs();
    const now = Date.now();
    const entries = await fs.readdir(env.AUDIO_STORAGE_DIR, { withFileTypes: true });
    let deleted = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(env.AUDIO_STORAGE_DIR, entry.name);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath);
          deleted += 1;
        }
      } catch (error) {
        log.warn({ err: error, filePath }, 'audio cleanup file error');
      }
    }

    if (deleted > 0) {
      log.info({ deleted }, 'audio cleanup completed');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.error({ err: error }, 'audio cleanup failed');
    }
  } finally {
    cleanupInProgress = false;
  }
}

export async function saveAudioAsset(input: SaveAudioInput): Promise<AudioAsset> {
  const extension = input.extension ?? 'wav';
  const fileName = `${randomUUID()}.${extension}`;
  const localPath = path.join(env.AUDIO_STORAGE_DIR, fileName);

  await fs.mkdir(env.AUDIO_STORAGE_DIR, { recursive: true });
  await fs.writeFile(localPath, input.data);
  ensureCleanupScheduled();

  const trimmedBaseUrl = env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');

  return {
    id: fileName,
    fileName,
    localPath,
    publicUrl: `${trimmedBaseUrl}/${fileName}`,
  };
}

export async function storeWav(
  callControlId: string,
  turnId: string,
  wavBuffer: Buffer,
): Promise<string> {
  const callSegment = sanitizeSegment(callControlId);
  const turnSegment = sanitizeSegment(turnId);
  const fileName = `${callSegment}_${turnSegment}_${randomUUID()}.wav`;
  const localPath = path.join(env.AUDIO_STORAGE_DIR, fileName);

  await fs.mkdir(env.AUDIO_STORAGE_DIR, { recursive: true });
  await fs.writeFile(localPath, wavBuffer);
  ensureCleanupScheduled();

  const trimmedBaseUrl = env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${trimmedBaseUrl}/${fileName}`;
}