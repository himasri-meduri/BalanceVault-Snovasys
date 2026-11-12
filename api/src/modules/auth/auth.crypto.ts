import crypto from 'node:crypto';
import argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options & { type: number } = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  if (!hash || !plaintext) {
    return false;
  }

  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function hashSessionToken(rawToken: string, sessionSecret: string): string {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`session:${rawToken}`)
    .digest('hex');
}

export function hashIpAddress(
  ip: string | undefined,
  sessionSecret: string,
): string | null {
  if (!ip) {
    return null;
  }
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`ip:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

export function createCsrfToken(sessionId: string, sessionSecret: string): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const signature = signCsrfNonce(sessionId, nonce, sessionSecret);
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(
  token: string,
  sessionId: string,
  sessionSecret: string,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [nonce, signature] = parts;
  if (!nonce || !signature || nonce.length < 16 || nonce.length > 64) {
    return false;
  }

  const expected = signCsrfNonce(sessionId, nonce, sessionSecret);
  const actualBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function signCsrfNonce(sessionId: string, nonce: string, sessionSecret: string): string {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`csrf:${sessionId}:${nonce}`)
    .digest('base64url');
}
