import type { Request, Response } from 'express';
import type { HealthService } from './health.service.js';

export function createHealthController(healthService: HealthService) {
  return {
    getHealth(req: Request, res: Response): void {
      res.status(200).json({
        ...healthService.getLiveness(),
        requestId: req.requestId,
      });
    },

    async getReady(req: Request, res: Response): Promise<void> {
      const readiness = await healthService.getReadiness();
      const statusCode = readiness.ready ? 200 : 503;

      res.status(statusCode).json({
        status: readiness.ready ? 'ready' : 'degraded',
        checks: readiness.checks,
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
      });
    },
  };
}
