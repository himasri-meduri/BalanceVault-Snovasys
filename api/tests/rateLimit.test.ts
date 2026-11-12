import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import {
  checkRedisHealth,
  computeRedisReconnectDelayMs,
} from '../src/config/redis.js';
import { createErrorHandler } from '../src/middleware/errorHandler.js';
import {
  createRateLimitMiddleware,
  type RedisRateLimitStore,
} from '../src/middleware/rateLimit.js';
import { requestIdMiddleware } from '../src/middleware/requestId.js';
import { HealthService } from '../src/modules/health/health.service.js';

describe('Redis rate limit middleware', () => {
  it('enforces maxRequests and emits rate limit headers', async () => {
    const counts = new Map<string, number>();
    const store: RedisRateLimitStore = {
      async incrementWindow(key) {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { count: next, ttlMs: 60_000 };
      },
    };

    const logger = createLogger('silent');
    const app = express();
    app.use(requestIdMiddleware);
    app.post(
      '/limited',
      createRateLimitMiddleware({
        keyPrefix: 'login',
        windowMs: 60_000,
        maxRequests: 2,
        store,
        logger,
      }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    app.use(createErrorHandler(logger));

    expect((await request(app).post('/limited')).status).toBe(200);
    expect((await request(app).post('/limited')).status).toBe(200);

    const third = await request(app).post('/limited');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeTruthy();
  });

  it('fails closed with 503 when Redis is unavailable and failClosed=true', async () => {
    const store: RedisRateLimitStore = {
      async incrementWindow() {
        throw new Error('Redis connection refused');
      },
    };

    const logger = createLogger('silent');
    const app = express();
    app.use(requestIdMiddleware);
    app.post(
      '/limited',
      createRateLimitMiddleware({
        keyPrefix: 'login',
        windowMs: 60_000,
        maxRequests: 5,
        failClosed: true,
        store,
        logger,
      }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    app.use(createErrorHandler(logger));

    const res = await request(app).post('/limited');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('keeps bounded non-null reconnect delays and handles stalled Redis health probes without crashing', async () => {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const delay = computeRedisReconnectDelayMs(attempt);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThan(15_200);
    }

    const stalledHealth = await checkRedisHealth(
      {
        status: 'reconnecting',
        connect: async () => undefined,
        ping: () =>
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error('late disconnect')), 40);
          }) as never,
      },
      10,
    );
    expect(stalledHealth).toBe('unavailable');
  });

  it('serves complete OpenAPI 3.0.3 documentation on /api/openapi.json', async () => {
    const app = createApp({
      env: parseEnv({
        NODE_ENV: 'test',
        PORT: '4000',
        APP_ORIGIN: 'http://localhost:5173',
        API_PUBLIC_URL: 'http://localhost:4000',
        DATABASE_URL: 'postgresql://app_runtime:secret@localhost:5432/balancevault',
        REDIS_URL: 'redis://localhost:6379',
        SESSION_SECRET: 'test-session-secret-that-is-well-over-32-characters-long',
        COOKIE_SECURE: 'false',
        COOKIE_SAME_SITE: 'lax',
        LOG_LEVEL: 'silent',
      }),
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
    });

    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths['/api/transfers']).toBeTruthy();
    expect(res.body.paths['/api/transactions/{id}/reverse']).toBeTruthy();
  });
});
