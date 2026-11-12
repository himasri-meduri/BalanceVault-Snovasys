import { describe, expect, it } from 'vitest';
import { getRedactedEnvSummary, parseEnv } from '../src/config/env.js';
import { normalizeRuntimeDatabaseUrl } from '../src/config/prisma.js';

const baseValidEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  APP_ORIGIN: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://app_runtime:secret@localhost:5432/balancevault',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a-very-long-test-session-secret-with-more-than-32-chars',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  LOG_LEVEL: 'silent',
};

describe('parseEnv', () => {
  it('parses valid environment configuration and redacts secrets in summary', () => {
    const env = parseEnv(baseValidEnv);
    expect(env.PORT).toBe(4000);
    expect(env.COOKIE_SECURE).toBe(false);

    const summary = getRedactedEnvSummary(env);
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(summary.databaseConfigured).toBe(true);
    expect(summary.redisConfigured).toBe(true);
  });

  it('rejects short or placeholder SESSION_SECRET', () => {
    expect(() =>
      parseEnv({ ...baseValidEnv, SESSION_SECRET: 'short' }),
    ).toThrow(/SESSION_SECRET/);

    expect(() =>
      parseEnv({
        ...baseValidEnv,
        SESSION_SECRET: 'REPLACE_WITH_LONG_RANDOM_SECRET_32_CHARS',
      }),
    ).toThrow(/placeholder/);
  });

  it('requires COOKIE_SECURE=true in production or with SameSite=none', () => {
    expect(() =>
      parseEnv({ ...baseValidEnv, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE/);

    expect(() =>
      parseEnv({ ...baseValidEnv, COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('bounds Prisma runtime pool parameters without overriding explicit query params', () => {
    const normalized = new URL(
      normalizeRuntimeDatabaseUrl(
        'postgresql://app_runtime:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
      )!,
    );
    expect(normalized.searchParams.get('connection_limit')).toBe('5');
    expect(normalized.searchParams.get('connect_timeout')).toBe('15');
    expect(normalized.searchParams.get('pool_timeout')).toBe('20');

    const preserved = new URL(
      normalizeRuntimeDatabaseUrl(
        'postgresql://app_runtime:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=9',
      )!,
    );
    expect(preserved.searchParams.get('pgbouncer')).toBe('true');
    expect(preserved.searchParams.get('connection_limit')).toBe('9');
    expect(normalizeRuntimeDatabaseUrl(undefined)).toBeUndefined();
  });
});
