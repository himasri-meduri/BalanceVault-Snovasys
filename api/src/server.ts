import { getRedactedEnvSummary, loadEnvFromDiskAndProcess } from './config/env.js';
import { createLogger } from './config/logger.js';
import { checkDatabaseHealth, createPrismaClient } from './config/prisma.js';
import { checkRedisHealth, createRedisClient } from './config/redis.js';
import { IoredisRateLimitStore } from './middleware/rateLimit.js';
import { PrismaAuditRepository } from './modules/audit/audit.repository.js';
import { AuditService } from './modules/audit/audit.service.js';
import { PrismaAuthRepository } from './modules/auth/auth.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { HealthService } from './modules/health/health.service.js';
import { PrismaLedgerRepository } from './modules/ledger/ledger.repository.js';
import { LedgerService } from './modules/ledger/ledger.service.js';
import { PrismaOnboardingRepository } from './modules/onboarding/onboarding.repository.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { createApp } from './app.js';

async function bootstrapServer() {
  const env = loadEnvFromDiskAndProcess();
  const logger = createLogger(env.LOG_LEVEL);

  const prisma = createPrismaClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL, logger);

  const healthService = new HealthService({
    checkDatabase: () => checkDatabaseHealth(prisma),
    checkRedis: () => checkRedisHealth(redis),
  });

  const auditService = new AuditService(new PrismaAuditRepository(prisma));
  const authService = new AuthService(new PrismaAuthRepository(prisma), env);
  const onboardingService = new OnboardingService(
    new PrismaOnboardingRepository(prisma),
    env,
  );
  const ledgerService = new LedgerService(new PrismaLedgerRepository(prisma), env);
  const rateLimitStore = new IoredisRateLimitStore(redis);

  const app = createApp({
    env,
    logger,
    healthService,
    authService,
    auditService,
    onboardingService,
    ledgerService,
    rateLimitStore,
  });

  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        config: getRedactedEnvSummary(env),
      },
      'BalanceVault API listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down BalanceVault API');
    server.close(async () => {
      await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

bootstrapServer().catch((err) => {
  console.error(
    'Failed to start BalanceVault API:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
