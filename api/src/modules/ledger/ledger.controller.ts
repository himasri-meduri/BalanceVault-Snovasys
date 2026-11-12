import type { Request, Response } from 'express';
import { UnauthorizedError, ValidationError } from '../../shared/errors.js';
import {
  accountIdParamSchema,
  adminCreateAccountSchema,
  createTransferSchema,
  freezeOrCloseAccountSchema,
  idempotencyKeySchema,
  listAccountsQuerySchema,
  listLedgerQuerySchema,
  reverseTransactionSchema,
  transactionIdParamSchema,
  unfreezeOrActivateAccountSchema,
} from './ledger.schemas.js';
import type { LedgerService } from './ledger.service.js';

export function createLedgerController(ledgerService: LedgerService) {
  return {
    async listAccounts(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const query = listAccountsQuerySchema.parse(req.query);
      const result = await ledgerService.listAccounts(req.auth, query);

      res.status(200).json({
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        requestId: req.requestId,
      });
    },

    async getAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const account = await ledgerService.getAccountById(req.auth, id);

      res.status(200).json({
        account,
        requestId: req.requestId,
      });
    },

    async getAccountLedger(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const query = listLedgerQuerySchema.parse(req.query);
      const result = await ledgerService.getAccountLedger(req.auth, id, query);

      res.status(200).json({
        account: result.account,
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        requestId: req.requestId,
      });
    },

    async getTransaction(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = transactionIdParamSchema.parse(req.params);
      const transaction = await ledgerService.getTransactionById(req.auth, id);

      res.status(200).json({
        transaction,
        requestId: req.requestId,
      });
    },

    async createTransfer(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const rawIdempotencyKey = req.get('Idempotency-Key');
      const parsedKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);
      if (!parsedKey.success) {
        throw new ValidationError('Invalid or missing Idempotency-Key header', {
          idempotencyKey: parsedKey.error.issues.map((issue) => issue.message),
        });
      }

      const body = createTransferSchema.parse(req.body);
      const result = await ledgerService.executeTransfer(
        req.auth,
        parsedKey.data,
        body,
        {
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      if (result.replayed) {
        res.setHeader('X-Idempotent-Replay', 'true');
      }

      res.status(result.statusCode).json({
        ...result.body,
        idempotentReplay: result.replayed,
        requestId: req.requestId,
      });
    },

    async reverseTransaction(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = transactionIdParamSchema.parse(req.params);
      const body = reverseTransactionSchema.parse(req.body);

      const result = await ledgerService.reverseTransaction(
        req.auth,
        id,
        body.reason,
        {
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.status(201).json({
        ...result,
        requestId: req.requestId,
      });
    },

    async adminCreateAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const body = adminCreateAccountSchema.parse(req.body);

      const result = await ledgerService.createCustomerAccount(req.auth, body, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(201).json({
        ...result,
        requestId: req.requestId,
      });
    },

    async adminActivateAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const body = unfreezeOrActivateAccountSchema.parse(req.body);

      const account = await ledgerService.activateAccount(
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
        account,
        requestId: req.requestId,
      });
    },

    async adminFreezeAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const body = freezeOrCloseAccountSchema.parse(req.body);

      const account = await ledgerService.freezeAccount(req.auth, id, body.reason, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        account,
        requestId: req.requestId,
      });
    },

    async adminUnfreezeAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const body = unfreezeOrActivateAccountSchema.parse(req.body);

      const account = await ledgerService.unfreezeAccount(
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
        account,
        requestId: req.requestId,
      });
    },

    async adminCloseAccount(req: Request, res: Response): Promise<void> {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { id } = accountIdParamSchema.parse(req.params);
      const body = freezeOrCloseAccountSchema.parse(req.body);

      const account = await ledgerService.closeAccount(req.auth, id, body.reason, {
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        account,
        requestId: req.requestId,
      });
    },
  };
}
