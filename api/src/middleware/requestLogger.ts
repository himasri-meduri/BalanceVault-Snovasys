import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';

export function createRequestLoggerMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const routePath = req.route?.path
        ? `${req.baseUrl}${req.route.path}`
        : req.path;

      const logPayload = {
        requestId: req.requestId,
        method: req.method,
        route: routePath,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };

      if (res.statusCode >= 500) {
        logger.error(logPayload, 'HTTP request failed');
      } else if (res.statusCode >= 400) {
        logger.warn(logPayload, 'HTTP request rejected');
      } else {
        logger.info(logPayload, 'HTTP request completed');
      }
    });

    next();
  };
}
