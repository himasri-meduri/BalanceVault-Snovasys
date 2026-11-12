import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { HealthService } from '../src/modules/health/health.service.js';

const testEnv = parseEnv({
  NODE_ENV: 'test',
  PORT: '4000',
  APP_ORIGIN: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://app_runtime:secret-db-pass@db.internal:5432/balancevault',
  REDIS_URL: 'redis://:secret-redis-pass@redis.internal:6379',
  SESSION_SECRET: 'test-session-secret-that-is-well-over-32-characters-long',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  LOG_LEVEL: 'silent',
});

describe('Health and readiness endpoints', () => {
  it('returns 200 for /api/health and /health with X-Request-Id and security headers', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
    });

    const res = await request(app).get('/api/health').set('X-Request-Id', 'req-123');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.status).toBe('ok');
    expect(res.body.requestId).toBe('req-123');

    const rootRes = await request(app).get('/health');
    expect(rootRes.status).toBe(200);
  });

  it('returns 200 on /api/ready when database and redis are healthy', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
    });

    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('returns 503 on /api/ready when database or redis is unavailable without leaking credentials', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'unavailable',
        checkRedis: async () => {
          throw new Error('ECONNREFUSED redis://:secret-redis-pass@redis.internal:6379');
        },
      }),
    });

    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual({ database: 'unavailable', redis: 'unavailable' });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('redis.internal');
  });

  it('allows exact configured CORS origin and omits credentials header for untrusted origins', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
    });

    const allowed = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns structured 404 JSON for unknown routes', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
    });

    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
