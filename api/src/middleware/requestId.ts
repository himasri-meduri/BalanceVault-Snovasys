import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId =
    incoming && SAFE_REQUEST_ID_REGEX.test(incoming) ? incoming : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
