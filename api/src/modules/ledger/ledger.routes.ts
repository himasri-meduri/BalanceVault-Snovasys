import { Router, type RequestHandler } from 'express';
import { UserRole } from '@prisma/client';
import { requireRole } from '../../middleware/authorize.js';
import { createLedgerController } from './ledger.controller.js';
import type { LedgerService } from './ledger.service.js';

export interface AccountsRouterDeps {
  ledgerService: LedgerService;
  requireAuth: RequestHandler;
}

export function createAccountsRouter(deps: AccountsRouterDeps): Router {
  const router = Router();
  const controller = createLedgerController(deps.ledgerService);

  router.get(
    '/',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.listAccounts(req, res).catch(next);
    },
  );

  router.get(
    '/:id',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.getAccount(req, res).catch(next);
    },
  );

  router.get(
    '/:id/ledger',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.getAccountLedger(req, res).catch(next);
    },
  );

  return router;
}

export interface TransactionsRouterDeps {
  ledgerService: LedgerService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
}

export function createTransactionsRouter(deps: TransactionsRouterDeps): Router {
  const router = Router();
  const controller = createLedgerController(deps.ledgerService);

  router.get(
    '/:id',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.getTransaction(req, res).catch(next);
    },
  );

  router.post(
    '/:id/reverse',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.reverseTransaction(req, res).catch(next);
    },
  );

  return router;
}

export interface TransfersRouterDeps {
  ledgerService: LedgerService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
  transferRateLimit: RequestHandler;
}

export function createTransfersRouter(deps: TransfersRouterDeps): Router {
  const router = Router();
  const controller = createLedgerController(deps.ledgerService);

  router.post(
    '/',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER),
    deps.requireCsrf,
    deps.transferRateLimit,
    (req, res, next) => {
      void controller.createTransfer(req, res).catch(next);
    },
  );

  return router;
}

export interface AdminAccountsRouterDeps {
  ledgerService: LedgerService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
}

export function createAdminAccountsRouter(deps: AdminAccountsRouterDeps): Router {
  const router = Router();
  const controller = createLedgerController(deps.ledgerService);

  router.post(
    '/',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.adminCreateAccount(req, res).catch(next);
    },
  );

  router.post(
    '/:id/activate',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.adminActivateAccount(req, res).catch(next);
    },
  );

  router.post(
    '/:id/freeze',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.adminFreezeAccount(req, res).catch(next);
    },
  );

  router.post(
    '/:id/unfreeze',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.adminUnfreezeAccount(req, res).catch(next);
    },
  );

  router.post(
    '/:id/close',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.adminCloseAccount(req, res).catch(next);
    },
  );

  return router;
}
