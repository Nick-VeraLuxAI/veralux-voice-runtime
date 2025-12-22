"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveAudioAsset = saveAudioAsset;
exports.storeWav = storeWav;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const env_1 = require("../env");
const log_1 = require("../log");
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 24;
let cleanupTimer;
let cleanupInProgress = false;
function sanitizeSegment(value) {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    return sanitized.length > 0 ? sanitized : 'unknown';
}
function getMaxAgeMs() {
    const parsed = Number.parseInt(process.env.AUDIO_CLEANUP_HOURS ?? '', 10);
    const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
    return hours * 60 * 60 * 1000;
}
function ensureCleanupScheduled() {
    if (cleanupTimer) {
        return;
    }
    cleanupTimer = setInterval(() => {
        void cleanupOldFiles();
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
}
async function cleanupOldFiles() {
    if (cleanupInProgress) {
        return;
    }
    cleanupInProgress = true;
    try {
        const maxAgeMs = getMaxAgeMs();
        const now = Date.now();
        const entries = await fs_1.promises.readdir(env_1.env.AUDIO_STORAGE_DIR, { withFileTypes: true });
        let deleted = 0;
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            const filePath = path_1.default.join(env_1.env.AUDIO_STORAGE_DIR, entry.name);
            try {
                const stats = await fs_1.promises.stat(filePath);
                if (now - stats.mtimeMs > maxAgeMs) {
                    await fs_1.promises.unlink(filePath);
                    deleted += 1;
                }
            }
            catch (error) {
                log_1.log.warn({ err: error, filePath }, 'audio cleanup file error');
            }
        }
        if (deleted > 0) {
            log_1.log.info({ deleted }, 'audio cleanup completed');
        }
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT') {
            log_1.log.error({ err: error }, 'audio cleanup failed');
        }
    }
    finally {
        cleanupInProgress = false;
    }
}
async function saveAudioAsset(input) {
    const extension = input.extension ?? 'wav';
    const fileName = `${(0, crypto_1.randomUUID)()}.${extension}`;
    const localPath = path_1.default.join(env_1.env.AUDIO_STORAGE_DIR, fileName);
    await fs_1.promises.mkdir(env_1.env.AUDIO_STORAGE_DIR, { recursive: true });
    await fs_1.promises.writeFile(localPath, input.data);
    ensureCleanupScheduled();
    const trimmedBaseUrl = env_1.env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
        id: fileName,
        fileName,
        localPath,
        publicUrl: `${trimmedBaseUrl}/${fileName}`,
    };
}
async function storeWav(callControlId, turnId, wavBuffer) {
    const callSegment = sanitizeSegment(callControlId);
    const turnSegment = sanitizeSegment(turnId);
    const fileName = `${callSegment}_${turnSegment}_${(0, crypto_1.randomUUID)()}.wav`;
    const localPath = path_1.default.join(env_1.env.AUDIO_STORAGE_DIR, fileName);
    await fs_1.promises.mkdir(env_1.env.AUDIO_STORAGE_DIR, { recursive: true });
    await fs_1.promises.writeFile(localPath, wavBuffer);
    ensureCleanupScheduled();
    const trimmedBaseUrl = env_1.env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
    return `${trimmedBaseUrl}/${fileName}`;
}
//# sourceMappingURL=audioStore.js.map