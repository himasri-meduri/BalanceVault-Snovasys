import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  generateOpaqueToken,
  hashPassword,
  hashSessionToken,
  verifyCsrfToken,
  verifyPassword,
} from '../src/modules/auth/auth.crypto.js';

describe('Auth cryptographic security primitives', () => {
  it('hashes passwords with Argon2id, uses unique salts, and verifies securely', async () => {
    const plain = 'StrongVault#2026';
    const hash1 = await hashPassword(plain);
    const hash2 = await hashPassword(plain);

    expect(hash1.startsWith('$argon2id$')).toBe(true);
    expect(hash1).not.toBe(plain);
    expect(hash1).not.toBe(hash2);

    expect(await verifyPassword(hash1, plain)).toBe(true);
    expect(await verifyPassword(hash1, 'WrongPassword#2026')).toBe(false);
    expect(await verifyPassword('not-a-valid-hash', plain)).toBe(false);
  });

  it('produces high-entropy opaque session tokens and keyed token hashes', () => {
    const secret = 'test-session-secret-that-is-well-over-32-characters-long';
    const t1 = generateOpaqueToken(32);
    const t2 = generateOpaqueToken(32);

    expect(t1.length).toBeGreaterThanOrEqual(42);
    expect(t1).not.toBe(t2);

    const h1 = hashSessionToken(t1, secret);
    const h2 = hashSessionToken(t1, secret);
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(t1);
  });

  it('binds CSRF tokens to a specific sessionId and rejects tampering', () => {
    const secret = 'test-session-secret-that-is-well-over-32-characters-long';
    const csrf = createCsrfToken('session-a', secret);

    expect(verifyCsrfToken(csrf, 'session-a', secret)).toBe(true);
    expect(verifyCsrfToken(csrf, 'session-b', secret)).toBe(false);
    expect(verifyCsrfToken(`${csrf}tamper`, 'session-a', secret)).toBe(false);
    expect(verifyCsrfToken('malformed', 'session-a', secret)).toBe(false);
  });
});
