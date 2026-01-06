"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeTenantConfigSchema = void 0;
exports.buildTenantConfigKey = buildTenantConfigKey;
exports.loadTenantConfig = loadTenantConfig;
const zod_1 = require("zod");
const env_1 = require("../env");
const log_1 = require("../log");
const client_1 = require("../redis/client");
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const BaseRuntimeTenantConfigSchema = zod_1.z
    .object({
    contractVersion: zod_1.z.literal('v1'),
    tenantId: zod_1.z.string().min(1),
    dids: zod_1.z.array(zod_1.z.string().regex(E164_REGEX, 'invalid E.164 DID')).min(1),
    webhookSecretRef: zod_1.z.string().min(1).optional(),
    webhookSecret: zod_1.z.string().min(1).optional(),
    caps: zod_1.z.object({
        maxConcurrentCallsTenant: zod_1.z.number().int().positive(),
        maxCallsPerMinuteTenant: zod_1.z.number().int().positive(),
        maxConcurrentCallsGlobal: zod_1.z.number().int().positive().optional(),
    }),
    stt: zod_1.z.object({
        mode: zod_1.z.enum(['whisper_http', 'disabled', 'http_wav_json']),
        whisperUrl: zod_1.z.string().min(1).optional(),
        chunkMs: zod_1.z.number().int().positive(),
        language: zod_1.z.string().min(1).optional(),
        config: zod_1.z
            .object({
            url: zod_1.z.string().min(1).optional(),
        })
            .optional(),
    }),
    tts: zod_1.z.object({
        mode: zod_1.z.literal('kokoro_http'),
        kokoroUrl: zod_1.z.string().min(1),
        voice: zod_1.z.string().min(1).optional(),
        format: zod_1.z.string().min(1).optional(),
        sampleRate: zod_1.z.number().int().positive().optional(),
    }),
    audio: zod_1.z.object({
        publicBaseUrl: zod_1.z.string().min(1).optional(),
        storageDir: zod_1.z.string().min(1).optional(),
        runtimeManaged: zod_1.z.boolean().optional(),
    }),
})
    .passthrough();
const RuntimeTenantConfigSchema = BaseRuntimeTenantConfigSchema.superRefine((value, ctx) => {
    if (!value.webhookSecretRef && !value.webhookSecret) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'webhookSecretRef or webhookSecret is required',
            path: ['webhookSecretRef'],
        });
    }
});
exports.RuntimeTenantConfigSchema = RuntimeTenantConfigSchema;
function buildTenantConfigKey(tenantId) {
    return `${env_1.env.TENANTCFG_PREFIX}:${tenantId}`;
}
async function loadTenantConfig(tenantId, redis = (0, client_1.getRedisClient)()) {
    const key = buildTenantConfigKey(tenantId);
    let raw;
    try {
        raw = await redis.get(key);
    }
    catch (error) {
        log_1.log.error({ err: error, tenant_id: tenantId, key }, 'tenant config fetch failed');
        return null;
    }
    if (!raw) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        log_1.log.error({ err: error, tenant_id: tenantId, key }, 'tenant config json parse failed');
        return null;
    }
    const result = RuntimeTenantConfigSchema.safeParse(parsed);
    if (!result.success) {
        log_1.log.error({ tenant_id: tenantId, key, issues: result.error.issues }, 'tenant config invalid');
        return null;
    }
    return result.data;
}
//# sourceMappingURL=tenantConfig.js.map