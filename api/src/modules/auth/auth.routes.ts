import { Router, type RequestHandler } from 'express';
import type { AppEnv } from '../../config/env.js';
import { createAuthController } from './auth.controller.js';
import type { AuthService } from './auth.service.js';

export interface AuthRouterDeps {
  authService: AuthService;
  env: AppEnv;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
  registerRateLimit: RequestHandler;
  loginRateLimit: RequestHandler;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const controller = createAuthController(deps.authService, deps.env);

  router.post('/register', deps.registerRateLimit, (req, res, next) => {
    void controller.register(req, res).catch(next);
  });

  router.post('/login', deps.loginRateLimit, (req, res, next) => {
    void controller.login(req, res).catch(next);
  });

  router.post('/logout', deps.requireAuth, deps.requireCsrf, (req, res, next) => {
    void controller.logout(req, res).catch(next);
  });

  router.get('/me', deps.requireAuth, (req, res) => {
    controller.me(req, res);
  });

  return router;
}
