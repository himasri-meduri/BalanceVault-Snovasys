import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../shared/errors.js';
import {
  applicationIdParamSchema,
  approveOnboardingSchema,
  listAdminOnboardingSchema,
  rejectOnboardingSchema,
  submitOnboardingSchema,
  updateOnboardingSchema,
} from './onboarding.schemas.js';
import type { OnboardingService } from './onboarding.service.js';

export function createOnboardingController(onboardingService: OnboardingService) {
  return {
    async getOwn(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const application = await onboardingService.getOwnApplication(req.auth);
      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },

    async updateOwn(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const input = updateOnboardingSchema.parse(req.body ?? {});
      const application = await onboardingService.updateOwnApplication(req.auth, input, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },

    async submitOwn(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const input = submitOnboardingSchema.parse(req.body ?? {});
      const application = await onboardingService.submitOwnApplication(req.auth, input, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },

    async listAdmin(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const query = listAdminOnboardingSchema.parse(req.query);
      const result = await onboardingService.listAdminApplications(req.auth, query);

      res.status(200).json({
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        requestId: req.requestId,
      });
    },

    async getAdminById(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const { id } = applicationIdParamSchema.parse(req.params);
      const application = await onboardingService.getAdminApplicationById(req.auth, id);

      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },

    async approve(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const { id } = applicationIdParamSchema.parse(req.params);
      const body = approveOnboardingSchema.parse(req.body ?? {});

      const application = await onboardingService.approveApplication(
        req.auth,
        id,
        body.reason,
        {
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },

    async reject(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const { id } = applicationIdParamSchema.parse(req.params);
      const body = rejectOnboardingSchema.parse(req.body ?? {});

      const application = await onboardingService.rejectApplication(
        req.auth,
        id,
        body.reason,
        {
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.status(200).json({
        application,
        requestId: req.requestId,
      });
    },
  };
}
