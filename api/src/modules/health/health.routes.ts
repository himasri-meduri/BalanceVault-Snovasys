import { Router } from 'express';
import { createHealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

export function createHealthRouter(healthService: HealthService): Router {
  const router = Router();
  const controller = createHealthController(healthService);

  router.get('/health', controller.getHealth);
  router.get('/ready', (req, res, next) => {
    void controller.getReady(req, res).catch(next);
  });

  return router;
}
