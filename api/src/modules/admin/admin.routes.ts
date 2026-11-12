import { Router, type RequestHandler } from 'express';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../../middleware/authorize.js';
import { UnauthorizedError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  changeUserRoleSchema,
  changeUserStatusSchema,
  listAdminPaginationSchema,
  listAdminUsersSchema,
} from '../auth/auth.schemas.js';
import type { AuthService } from '../auth/auth.service.js';
import type { LedgerService } from '../ledger/ledger.service.js';

const uuidParamSchema = z.object({
  id: z.string().uuid('Invalid user ID format'),
});

export interface AdminRouterDeps {
  authService: AuthService;
  auditService: AuditService;
  ledgerService?: LedgerService;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  if (deps.ledgerService) {
    const ledgerService = deps.ledgerService;
    router.get(
      '/summary',
      deps.requireAuth,
      requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
      (req, res, next) => {
        if (!req.auth) {
          next(new UnauthorizedError('Authentication required'));
          return;
        }
        void ledgerService
          .getAdminSummary(req.auth)
          .then((summary) => {
            res.status(200).json({
              ...summary,
              requestId: req.requestId,
            });
          })
          .catch(next);
      },
    );
  }

  router.get(
    '/users',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      const query = listAdminUsersSchema.parse(req.query);
      void deps.authService
        .listUsers({
          page: query.page,
          pageSize: query.pageSize,
          search: query.search,
          role: query.role,
          status: query.status,
        })
        .then((result) => {
          res.status(200).json({
            items: result.items,
            total: result.total,
            page: query.page,
            pageSize: query.pageSize,
            requestId: req.requestId,
          });
        })
        .catch(next);
    },
  );

  router.get(
    '/users/:id',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      const { id } = uuidParamSchema.parse(req.params);
      void deps.authService
        .getUserDetail(id)
        .then((user) => {
          res.status(200).json({
            user,
            requestId: req.requestId,
          });
        })
        .catch(next);
    },
  );

  router.patch(
    '/users/:id/status',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      if (!req.auth) {
        next(new UnauthorizedError('Authentication required'));
        return;
      }

      const { id } = uuidParamSchema.parse(req.params);
      const body = changeUserStatusSchema.parse(req.body);

      void deps.authService
        .changeUserStatus(
          {
            actor: req.auth,
            targetUserId: id,
            newStatus: body.status,
            reason: body.reason,
          },
          {
            requestId: req.requestId,
            ip: req.ip,
            userAgent: req.get('user-agent'),
          },
        )
        .then((updatedUser) => {
          res.status(200).json({
            user: updatedUser,
            requestId: req.requestId,
          });
        })
        .catch(next);
    },
  );

  router.patch(
    '/users/:id/role',
    deps.requireAuth,
    requireRole(UserRole.SUPER_ADMIN),
    deps.requireCsrf,
    (req, res, next) => {
      if (!req.auth) {
        next(new UnauthorizedError('Authentication required'));
        return;
      }

      const { id } = uuidParamSchema.parse(req.params);
      const body = changeUserRoleSchema.parse(req.body);

      void deps.authService
        .changeUserRole(
          {
            actor: req.auth,
            targetUserId: id,
            newRole: body.role,
            reason: body.reason,
          },
          {
            requestId: req.requestId,
            ip: req.ip,
            userAgent: req.get('user-agent'),
          },
        )
        .then((updatedUser) => {
          res.status(200).json({
            user: updatedUser,
            requestId: req.requestId,
          });
        })
        .catch(next);
    },
  );

  router.get(
    '/audit-events',
    deps.requireAuth,
    requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    (req, res, next) => {
      const query = listAdminPaginationSchema.parse(req.query);
      void deps.auditService
        .listEvents({
          page: query.page,
          pageSize: query.pageSize,
          action: query.action,
          entityType: query.entityType,
          actorUserId: query.actorUserId,
          from: query.from,
          to: query.to,
        })
        .then((result) => {
          res.status(200).json({
            items: result.items,
            total: result.total,
            page: query.page,
            pageSize: query.pageSize,
            requestId: req.requestId,
          });
        })
        .catch(next);
    },
  );

  return router;
}
