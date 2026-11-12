import 'express';
import type { AuthenticatedContext } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthenticatedContext;
    }
  }
}
