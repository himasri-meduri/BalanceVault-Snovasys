import type { Request, Response, NextFunction } from 'express';
import type { AppEnv } from '../config/env.js';
import { UnauthorizedError } from '../shared/errors.js';
import {
  buildClearSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '../modules/auth/auth.controller.js';
import type { AuthService } from '../modules/auth/auth.service.js';

export function createAuthenticateMiddleware(authService: AuthService, env: AppEnv) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (typeof rawToken !== 'string' || !rawToken) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    try {
      req.auth = await authService.authenticateSession(rawToken);
      next();
    } catch (err) {
      res.clearCookie(SESSION_COOKIE_NAME, buildClearSessionCookieOptions(env));
      next(err);
    }
  };
}
