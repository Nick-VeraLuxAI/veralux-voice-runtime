import Redis from 'ioredis';
import { env } from '../env';
import { log } from '../log';

export type RedisClient = Redis;

let singleton: Redis | null = null;

export function createRedisClient(url: string = env.REDIS_URL): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  client.on('connect', () => {
    log.info({ event: 'redis_connect' }, 'redis connect');
  });

  client.on('ready', () => {
    log.info({ event: 'redis_ready' }, 'redis ready');
  });

  client.on('error', (error) => {
    log.error({ err: error }, 'redis error');
  });

  client.on('end', () => {
    log.warn({ event: 'redis_end' }, 'redis connection ended');
  });

  return client;
}

export function getRedisClient(): Redis {
  if (!singleton) {
    singleton = createRedisClient();
  }

  return singleton;
}

export function setRedisClient(client: Redis | null): void {
  singleton = client;
}