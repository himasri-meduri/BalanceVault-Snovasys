import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';

export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.requestId ?? 'unknown';

    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
          requestId,
        },
      });
      return;
    }

    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || 'body';
        fieldErrors[key] = fieldErrors[key] ?? [];
        fieldErrors[key].push(issue.message);
      }

      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fieldErrors,
          requestId,
        },
      });
      return;
    }

    if (
      err instanceof SyntaxError &&
      'status' in err &&
      (err as { status?: number }).status === 400
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Malformed JSON request body',
          requestId,
        },
      });
      return;
    }

    logger.error(
      {
        requestId,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'Unhandled API error',
    );

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred',
        requestId,
      },
    });
  };
}
