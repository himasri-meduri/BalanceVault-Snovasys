import type { Request, Response, NextFunction } from 'express';
import type { AppEnv } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../shared/errors.js';
import { verifyCsrfToken } from '../modules/auth/auth.crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createCsrfMiddleware(env: AppEnv) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (!req.auth) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const origin = req.header('origin');
    if (origin && origin !== env.APP_ORIGIN) {
      next(new ForbiddenError('Untrusted request origin', 'CSRF_INVALID'));
      return;
    }

    const csrfToken = req.header('x-csrf-token');
    if (
      typeof csrfToken !== 'string' ||
      !verifyCsrfToken(csrfToken, req.auth.sessionId, env.SESSION_SECRET)
    ) {
      next(new ForbiddenError('Invalid or missing CSRF token', 'CSRF_INVALID'));
      return;
    }

    next();
  };
}
