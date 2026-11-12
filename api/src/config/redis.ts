import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export function computeRedisReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, attempt);
  const exponential = Math.min(200 * 2 ** Math.min(safeAttempt - 1, 6), 15_000);
  const jitter = Math.floor(Math.random() * 100);
  return exponential + jitter;
}

export function createRedisClient(redisUrl: string, logger: Logger): Redis {
  const isTls = redisUrl.startsWith('rediss://');

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 4000,
    keepAlive: 10_000,
    ...(isTls ? { tls: {} } : {}),
    retryStrategy(times) {
      return computeRedisReconnectDelayMs(times);
    },
  });

  client.on('error', (err) => {
    logger.warn(
      {
        component: 'redis',
        code: (err as NodeJS.ErrnoException).code ?? 'REDIS_ERROR',
      },
      'Redis client error',
    );
  });

  client.on('reconnecting', (delayMs: number) => {
    logger.debug(
      {
        component: 'redis',
        delayMs,
      },
      'Redis client reconnecting',
    );
  });

  client.on('ready', () => {
    logger.info({ component: 'redis' }, 'Redis client ready');
  });

  return client;
}

export async function checkRedisHealth(
  redis: Pick<Redis, 'ping' | 'status' | 'connect'>,
  timeoutMs = 3000,
): Promise<'ok' | 'unavailable'> {
  let timer: NodeJS.Timeout | undefined;
  const pingPromise = (async () => {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG';
  })().catch(() => false);

  try {
    const ok = await Promise.race([
      pingPromise,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);

    return ok ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
