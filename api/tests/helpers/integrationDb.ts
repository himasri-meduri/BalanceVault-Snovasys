import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

/**
 * Ensures remote PostgreSQL pooler tests allow transient WAN/TLS handshake variance
 * without altering production credentials or .env values.
 */
export function buildIntegrationDatabaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', '6');
  }
  if (!parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', '15');
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', '20');
  }
  return parsed.toString();
}

export async function warmupLiveDependencies(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  redis: Pick<Redis, 'status' | 'connect' | 'ping'>,
): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    // One clean retry handles cold Supavisor TLS handshake spikes
    await prisma.$queryRaw`SELECT 1`;
  }

  if (redis.status === 'wait') {
    await redis.connect();
  }
  await redis.ping();
}
