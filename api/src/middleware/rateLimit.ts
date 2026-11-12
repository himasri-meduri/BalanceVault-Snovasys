import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';
import { RateLimitError, ServiceUnavailableError } from '../shared/errors.js';

export interface RedisRateLimitStore {
  incrementWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

export class IoredisRateLimitStore implements RedisRateLimitStore {
  constructor(
    private readonly redis: {
      status: string;
      connect: () => Promise<unknown>;
      eval: (
        script: string,
        numkeys: number,
        ...args: Array<string | number>
      ) => Promise<unknown>;
    },
  ) {}

  async incrementWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; ttlMs: number }> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }

    // Atomic INCR + PEXPIRE-if-new in Lua so counters always expire
    const lua = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
      end
      local ttl = redis.call("PTTL", KEYS[1])
      return { current, ttl }
    `;

    const result = (await this.redis.eval(lua, 1, key, windowMs)) as [number, number];
    return {
      count: Number(result[0] ?? 1),
      ttlMs: Math.max(Number(result[1] ?? windowMs), 0),
    };
  }
}

export interface RateLimitOptions {
  keyPrefix: string;
  windowMs: number;
  maxRequests: number;
  failClosed?: boolean;
  keyBuilder?: (req: Request) => string;
  store: RedisRateLimitStore;
  logger: Logger;
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  const {
    keyPrefix,
    windowMs,
    maxRequests,
    failClosed = true,
    keyBuilder = (req) => req.ip || 'unknown',
    store,
    logger,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `rl:${keyPrefix}:${keyBuilder(req)}`;

    try {
      const { count, ttlMs } = await store.incrementWindow(key, windowMs);
      const remaining = Math.max(maxRequests - count, 0);

      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + ttlMs) / 1000)));

      if (count > maxRequests) {
        res.setHeader('Retry-After', String(Math.max(Math.ceil(ttlMs / 1000), 1)));
        next(new RateLimitError());
        return;
      }

      next();
    } catch (err) {
      logger.warn(
        {
          requestId: req.requestId,
          keyPrefix,
          failClosed,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        },
        'Rate limit backend unavailable',
      );

      if (failClosed) {
        next(new ServiceUnavailableError('Security rate limiting service is unavailable'));
        return;
      }

      next();
    }
  };
}
