import type { Request, Response } from 'express';
import type { AppEnv } from '../../config/env.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { loginSchema, registerSchema } from './auth.schemas.js';
import type { AuthService } from './auth.service.js';

export const SESSION_COOKIE_NAME = 'bv_sid';

export function buildSessionCookieOptions(env: AppEnv) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  } as const;
}

export function buildClearSessionCookieOptions(env: AppEnv) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
  } as const;
}

export function createAuthController(authService: AuthService, env: AppEnv) {
  return {
    async register(req: Request, res: Response): Promise<void> {
      const input = registerSchema.parse(req.body);
      const result = await authService.registerCustomer(input, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.cookie(
        SESSION_COOKIE_NAME,
        result.sessionToken,
        buildSessionCookieOptions(env),
      );

      res.status(201).json({
        user: result.user,
        csrfToken: result.csrfToken,
        requestId: req.requestId,
      });
    },

    async login(req: Request, res: Response): Promise<void> {
      const input = loginSchema.parse(req.body);
      const existingCookie =
        typeof req.cookies?.[SESSION_COOKIE_NAME] === 'string'
          ? (req.cookies[SESSION_COOKIE_NAME] as string)
          : undefined;

      const result = await authService.login(
        {
          ...input,
          previousRawSessionToken: existingCookie,
        },
        {
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.cookie(
        SESSION_COOKIE_NAME,
        result.sessionToken,
        buildSessionCookieOptions(env),
      );

      res.status(200).json({
        user: result.user,
        csrfToken: result.csrfToken,
        requestId: req.requestId,
      });
    },

    async logout(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      await authService.logout(req.auth, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.clearCookie(SESSION_COOKIE_NAME, buildClearSessionCookieOptions(env));
      res.status(200).json({
        loggedOut: true,
        requestId: req.requestId,
      });
    },

    me(req: Request, res: Response): void {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const csrfToken = authService.issueCsrfTokenForSession(req.auth.sessionId);

      res.status(200).json({
        user: {
          id: req.auth.userId,
          email: req.auth.email,
          fullName: req.auth.fullName,
          role: req.auth.role,
          status: req.auth.status,
          onboardingStatus: req.auth.onboardingStatus,
        },
        csrfToken,
        requestId: req.requestId,
      });
    },
  };
}
