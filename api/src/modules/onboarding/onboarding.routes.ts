import { Router, type RequestHandler } from 'express';
import { UserRole } from '@prisma/client';
import { requireRole } from '../../middleware/authorize.js';
import { createOnboardingController } from './onboarding.controller.js';
import type { OnboardingService } from './onboarding.service.js';

export interface CustomerOnboardingRouterDeps {
  onboardingService: OnboardingService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
  onboardingSubmitRateLimit: RequestHandler;
}

export function createCustomerOnboardingRouter(
  deps: CustomerOnboardingRouterDeps,
): Router {
  const router = Router();
  const controller = createOnboardingController(deps.onboardingService);

  router.get(
    '/me',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER),
    (req, res, next) => {
      void controller.getOwn(req, res).catch(next);
    },
  );

  router.patch(
    '/me',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.updateOwn(req, res).catch(next);
    },
  );

  router.post(
    '/me/submit',
    deps.requireAuth,
    requireRole(UserRole.CUSTOMER),
    deps.requireCsrf,
    deps.onboardingSubmitRateLimit,
    (req, res, next) => {
      void controller.submitOwn(req, res).catch(next);
    },
  );

  return router;
}

export interface AdminOnboardingRouterDeps {
  onboardingService: OnboardingService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
}

export function createAdminOnboardingRouter(
  deps: AdminOnboardingRouterDeps,
): Router {
  const router = Router();
  const controller = createOnboardingController(deps.onboardingService);

  router.get(
    '/applications',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.listAdmin(req, res).catch(next);
    },
  );

  router.get(
    '/',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.listAdmin(req, res).catch(next);
    },
  );

  router.get(
    '/applications/:id',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      void controller.getAdminById(req, res).catch(next);
    },
  );

  router.post(
    '/applications/:id/approve',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.approve(req, res).catch(next);
    },
  );

  router.post(
    '/applications/:id/reject',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.reject(req, res).catch(next);
    },
  );

  router.post(
    '/:id/approve',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.approve(req, res).catch(next);
    },
  );

  router.post(
    '/:id/reject',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      void controller.reject(req, res).catch(next);
    },
  );

  return router;
}
