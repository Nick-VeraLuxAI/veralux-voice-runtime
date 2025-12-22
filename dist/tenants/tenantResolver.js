"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeE164 = normalizeE164;
exports.resolveTenantId = resolveTenantId;
const env_1 = require("../env");
const log_1 = require("../log");
const client_1 = require("../redis/client");
function normalizeE164(toNumber) {
    return toNumber.trim().replace(/\s+/g, '');
}
async function resolveTenantId(toNumber, redis = (0, client_1.getRedisClient)()) {
    const normalized = normalizeE164(toNumber);
    if (!normalized) {
        return null;
    }
    const key = `${env_1.env.TENANTMAP_PREFIX}:did:${normalized}`;
    try {
        const tenantId = await redis.get(key);
        return tenantId ?? null;
    }
    catch (error) {
        log_1.log.error({ err: error, did: normalized }, 'tenant resolve failed');
        return null;
    }
}
//# sourceMappingURL=tenantResolver.js.map