import crypto from 'node:crypto';
import {
  IoredisRateLimitStore,
  type RedisRateLimitStore,
} from '../../src/middleware/rateLimit.js';

export type IsolatedRedisClient = ConstructorParameters<typeof IoredisRateLimitStore>[0] & {
  del: (...keys: string[]) => Promise<number>;
};

/**
 * Isolates live Redis rate-limit keys per integration test execution so
 * real Redis Lua INCR/PEXPIRE/429 enforcement is exercised deterministically
 * without cross-test or stale-counter interference, and removes created keys
 * on cleanup.
 */
export class IsolatedIntegrationRateLimitStore implements RedisRateLimitStore {
  public readonly namespace: string;
  public readonly touchedKeys = new Set<string>();
  private readonly inner: IoredisRateLimitStore;

  constructor(
    private readonly redis: IsolatedRedisClient,
    suiteTag: string,
  ) {
    this.inner = new IoredisRateLimitStore(redis);
    this.namespace = `inttest:${suiteTag}:${crypto.randomUUID()}`;
  }

  async incrementWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; ttlMs: number }> {
    const isolatedKey = `${this.namespace}:${key}`;
    this.touchedKeys.add(isolatedKey);
    return this.inner.incrementWindow(isolatedKey, windowMs);
  }

  async cleanup(): Promise<number> {
    if (this.touchedKeys.size === 0) {
      return 0;
    }
    const keys = Array.from(this.touchedKeys);
    this.touchedKeys.clear();
    return this.redis.del(...keys);
  }
}
