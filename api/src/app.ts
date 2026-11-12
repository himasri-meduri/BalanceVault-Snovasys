import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { Logger } from 'pino';
import type { AppEnv } from './config/env.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { createRequestLoggerMiddleware } from './middleware/requestLogger.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { createAuthenticateMiddleware } from './middleware/authenticate.js';
import { createCsrfMiddleware } from './middleware/csrf.js';
import {
  createRateLimitMiddleware,
  type RedisRateLimitStore,
} from './middleware/rateLimit.js';
import { NotFoundError } from './shared/errors.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import type { HealthService } from './modules/health/health.service.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import type { AuditService } from './modules/audit/audit.service.js';
import {
  createAdminOnboardingRouter,
  createCustomerOnboardingRouter,
} from './modules/onboarding/onboarding.routes.js';
import type { OnboardingService } from './modules/onboarding/onboarding.service.js';
import {
  createAccountsRouter,
  createAdminAccountsRouter,
  createTransactionsRouter,
  createTransfersRouter,
} from './modules/ledger/ledger.routes.js';
import type { LedgerService } from './modules/ledger/ledger.service.js';
import { buildOpenApiSpec } from './modules/openapi/openapi.spec.js';

export interface AppDependencies {
  env: AppEnv;
  logger: Logger;
  healthService: HealthService;
  authService?: AuthService;
  auditService?: AuditService;
  onboardingService?: OnboardingService;
  ledgerService?: LedgerService;
  rateLimitStore?: RedisRateLimitStore;
  rateLimitConfig?: {
    registerMax?: number;
    loginMax?: number;
    onboardingSubmitMax?: number;
    transferMax?: number;
    windowMs?: number;
  };
}

export function createApp(deps: AppDependencies): Express {
  const { env, logger, healthService } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === env.APP_ORIGIN) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));
  app.use(createRequestLoggerMiddleware(logger));

  const healthRouter = createHealthRouter(healthService);
  app.use(healthRouter);
  app.use('/api', healthRouter);

  app.get('/api', (req, res) => {
    res.status(200).json({
      service: 'balancevault-api',
      mode: 'synthetic-demo',
      notice: 'Demo environment — synthetic data only. No real funds or bank integrations.',
      openApiUrl: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/openapi.json`,
      requestId: req.requestId,
    });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.status(200).json(buildOpenApiSpec(env.API_PUBLIC_URL));
  });

  if (deps.authService) {
    const requireAuth = createAuthenticateMiddleware(deps.authService, env);
    const requireCsrf = createCsrfMiddleware(env);
    const store: RedisRateLimitStore = deps.rateLimitStore ?? {
      async incrementWindow() {
        throw new Error('Rate limit store not configured');
      },
    };

    const windowMs = deps.rateLimitConfig?.windowMs ?? 15 * 60 * 1000;
    const registerRateLimit = createRateLimitMiddleware({
      keyPrefix: 'auth:register',
      windowMs,
      maxRequests: deps.rateLimitConfig?.registerMax ?? 10,
      failClosed: true,
      store,
      logger,
    });
    const loginRateLimit = createRateLimitMiddleware({
      keyPrefix: 'auth:login',
      windowMs,
      maxRequests: deps.rateLimitConfig?.loginMax ?? 15,
      failClosed: true,
      store,
      logger,
    });
    const onboardingSubmitRateLimit = createRateLimitMiddleware({
      keyPrefix: 'onboarding:submit',
      windowMs,
      maxRequests: deps.rateLimitConfig?.onboardingSubmitMax ?? 10,
      failClosed: true,
      keyBuilder: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
      store,
      logger,
    });
    const transferRateLimit = createRateLimitMiddleware({
      keyPrefix: 'ledger:transfer',
      windowMs,
      maxRequests: deps.rateLimitConfig?.transferMax ?? 20,
      failClosed: true,
      keyBuilder: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
      store,
      logger,
    });

    app.use(
      '/api/auth',
      createAuthRouter({
        authService: deps.authService,
        env,
        requireAuth,
        requireCsrf,
        registerRateLimit,
        loginRateLimit,
      }),
    );

    if (deps.onboardingService) {
      app.use(
        '/api/onboarding',
        createCustomerOnboardingRouter({
          onboardingService: deps.onboardingService,
          requireAuth,
          requireCsrf,
          onboardingSubmitRateLimit,
        }),
      );

      app.use(
        '/api/admin/onboarding',
        createAdminOnboardingRouter({
          onboardingService: deps.onboardingService,
          requireAuth,
          requireCsrf,
        }),
      );
    }

    if (deps.ledgerService) {
      app.use(
        '/api/accounts',
        createAccountsRouter({
          ledgerService: deps.ledgerService,
          requireAuth,
        }),
      );

      app.use(
        '/api/transactions',
        createTransactionsRouter({
          ledgerService: deps.ledgerService,
          requireAuth,
          requireCsrf,
        }),
      );

      app.use(
        '/api/transfers',
        createTransfersRouter({
          ledgerService: deps.ledgerService,
          requireAuth,
          requireCsrf,
          transferRateLimit,
        }),
      );

      app.use(
        '/api/admin/accounts',
        createAdminAccountsRouter({
          ledgerService: deps.ledgerService,
          requireAuth,
          requireCsrf,
        }),
      );
    }

    if (deps.auditService) {
      app.use(
        '/api/admin',
        createAdminRouter({
          authService: deps.authService,
          auditService: deps.auditService,
          ledgerService: deps.ledgerService,
          requireAuth,
          requireCsrf,
        }),
      );
    }
  }

  app.use((_req, _res, next) => {
    next(new NotFoundError('Endpoint not found'));
  });

  app.use(createErrorHandler(logger));

  return app;
}
