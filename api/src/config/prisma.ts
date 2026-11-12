import { PrismaClient } from '@prisma/client';

export function normalizeRuntimeDatabaseUrl(
  databaseUrl?: string,
  defaultConnectionLimit = 5,
): string | undefined {
  if (!databaseUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return databaseUrl;
    }

    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', String(defaultConnectionLimit));
    }
    if (!parsed.searchParams.has('connect_timeout')) {
      parsed.searchParams.set('connect_timeout', '15');
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', '20');
    }

    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const normalizedUrl = normalizeRuntimeDatabaseUrl(databaseUrl);

  return new PrismaClient(
    normalizedUrl
      ? {
          datasources: {
            db: { url: normalizedUrl },
          },
        }
      : undefined,
  );
}

export async function checkDatabaseHealth(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  timeoutMs = 3000,
): Promise<'ok' | 'unavailable'> {
  let timer: NodeJS.Timeout | undefined;
  const probePromise = Promise.resolve(prisma.$queryRaw`SELECT 1`).then(
    () => true,
    () => false,
  );

  try {
    const ok = await Promise.race([
      probePromise,
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
