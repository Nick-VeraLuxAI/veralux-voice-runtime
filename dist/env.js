"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const emptyToUndefined = (value) => {
    if (typeof value === 'string' && value.trim() === '') {
        return undefined;
    }
    return value;
};
const EnvSchema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().int().positive(),
    TELNYX_API_KEY: zod_1.z.string().min(1),
    TELNYX_PUBLIC_KEY: zod_1.z.string().min(1),
    MEDIA_STREAM_TOKEN: zod_1.z.string().min(1),
    AUDIO_PUBLIC_BASE_URL: zod_1.z.string().min(1),
    AUDIO_STORAGE_DIR: zod_1.z.string().min(1),
    WHISPER_URL: zod_1.z.string().min(1),
    KOKORO_URL: zod_1.z.string().min(1),
    STT_CHUNK_MS: zod_1.z.coerce.number().int().positive(),
    STT_SILENCE_MS: zod_1.z.coerce.number().int().positive(),
    DEAD_AIR_MS: zod_1.z.coerce.number().int().positive(),
    REDIS_URL: zod_1.z.string().min(1),
    GLOBAL_CONCURRENCY_CAP: zod_1.z.coerce.number().int().positive(),
    TENANT_CONCURRENCY_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    TENANT_CALLS_PER_MIN_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    CAPACITY_TTL_SECONDS: zod_1.z.coerce.number().int().positive(),
    TENANTMAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('tenantmap')),
    CAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('cap')),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
    throw new Error(`Invalid environment variables: ${issues}`);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map