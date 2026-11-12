import crypto from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomGroup(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

export function generateAccountReference(): string {
  return `BV-${randomGroup(4)}-${randomGroup(4)}`;
}

export function generateTransactionReference(): string {
  return `TXN-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}
