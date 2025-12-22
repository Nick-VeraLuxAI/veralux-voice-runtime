"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRedisClient = createRedisClient;
exports.getRedisClient = getRedisClient;
exports.setRedisClient = setRedisClient;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../env");
const log_1 = require("../log");
let singleton = null;
function createRedisClient(url = env_1.env.REDIS_URL) {
    const client = new ioredis_1.default(url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
    });
    client.on('connect', () => {
        log_1.log.info({ event: 'redis_connect' }, 'redis connect');
    });
    client.on('ready', () => {
        log_1.log.info({ event: 'redis_ready' }, 'redis ready');
    });
    client.on('error', (error) => {
        log_1.log.error({ err: error }, 'redis error');
    });
    client.on('end', () => {
        log_1.log.warn({ event: 'redis_end' }, 'redis connection ended');
    });
    return client;
}
function getRedisClient() {
    if (!singleton) {
        singleton = createRedisClient();
    }
    return singleton;
}
function setRedisClient(client) {
    singleton = client;
}
//# sourceMappingURL=client.js.map