export function buildOpenApiSpec(serverUrl = 'http://localhost:4000') {
  return {
    openapi: '3.0.3',
    info: {
      title: 'BalanceVault Synthetic Ledger & Account Operations API',
      version: '1.0.0',
      description:
        'Demo environment — synthetic INR data only (integer minor units / paise). No real funds, real KYC, or real bank integrations.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'bv_sid',
        },
        csrfToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-CSRF-Token',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
                fieldErrors: {
                  type: 'object',
                  additionalProperties: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          summary: 'Liveness probe',
          responses: { '200': { description: 'Service alive' } },
        },
      },
      '/api/ready': {
        get: {
          summary: 'Dependency readiness (PostgreSQL + Redis)',
          responses: {
            '200': { description: 'Dependencies healthy' },
            '503': { description: 'One or more dependencies unavailable' },
          },
        },
      },
      '/api/auth/register': {
        post: {
          summary: 'Register a synthetic CUSTOMER and initialize PENDING onboarding',
          responses: {
            '201': { description: 'Customer registered and session cookie set' },
            '400': { description: 'Validation error or disallowed fields' },
            '409': { description: 'Normalized email already registered' },
            '429': { description: 'Registration rate limit exceeded' },
          },
        },
      },
      '/api/auth/login': {
        post: {
          summary: 'Authenticate email/password and rotate opaque bv_sid session',
          responses: {
            '200': { description: 'Authenticated; cookie and CSRF token returned' },
            '401': { description: 'Generic invalid credentials response' },
            '429': { description: 'Login rate limit exceeded' },
          },
        },
      },
      '/api/auth/logout': {
        post: {
          summary: 'Revoke active session and clear bv_sid cookie',
          security: [{ cookieAuth: [], csrfToken: [] }],
          responses: { '200': { description: 'Session revoked' } },
        },
      },
      '/api/auth/me': {
        get: {
          summary: 'Inspect current authenticated user summary and CSRF token',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Current user summary' },
            '401': { description: 'Authentication required' },
          },
        },
      },
      '/api/onboarding/me': {
        get: {
          summary: 'Customer: view own onboarding application',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Onboarding application' } },
        },
        patch: {
          summary: 'Customer: update draft fields or reopen REJECTED application',
          security: [{ cookieAuth: [], csrfToken: [] }],
          responses: {
            '200': { description: 'Onboarding updated' },
            '409': { description: 'Invalid onboarding state transition' },
          },
        },
      },
      '/api/onboarding/me/submit': {
        post: {
          summary: 'Customer: submit onboarding profile for admin review',
          security: [{ cookieAuth: [], csrfToken: [] }],
          responses: {
            '200': { description: 'Submitted' },
            '400': { description: 'Incomplete fields or terms unaccepted' },
            '429': { description: 'Rate limit exceeded' },
          },
        },
      },
      '/api/admin/onboarding': {
        get: {
          summary: 'Admin: list and filter customer onboarding applications',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Paginated onboarding applications' } },
        },
      },
      '/api/admin/onboarding/applications': {
        get: {
          summary: 'Admin: list and filter customer onboarding applications',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Paginated onboarding applications' } },
        },
      },
      '/api/admin/onboarding/applications/{id}': {
        get: {
          summary: 'Admin: inspect single onboarding application',
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Application details' } },
        },
      },
      '/api/admin/onboarding/applications/{id}/approve': {
        post: {
          summary: 'Admin: approve submitted onboarding application',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Approved with audit event' } },
        },
      },
      '/api/admin/onboarding/applications/{id}/reject': {
        post: {
          summary: 'Admin: reject onboarding application with mandatory reason',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Rejected with audit event' } },
        },
      },
      '/api/accounts': {
        get: {
          summary: 'List synthetic accounts (Customer: own only; Admin: searchable directory)',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Paginated accounts list' } },
        },
      },
      '/api/accounts/{id}': {
        get: {
          summary: 'Get synthetic account details (Owner or Admin)',
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Account detail' },
            '404': { description: 'Missing or concealed account' },
          },
        },
      },
      '/api/accounts/{id}/ledger': {
        get: {
          summary: 'Get paginated double-entry ledger entries for an account (Owner or Admin)',
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Paginated account ledger entries' } },
        },
      },
      '/api/transfers': {
        post: {
          summary: 'Customer: execute idempotent atomic synthetic INR internal transfer',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 16, maxLength: 128 },
            },
          ],
          responses: {
            '201': { description: 'Transfer posted (or replayed for identical idempotency key)' },
            '400': { description: 'Missing/invalid Idempotency-Key or payload validation error' },
            '403': { description: 'Customer not eligible or unapproved' },
            '409': { description: 'Account not ACTIVE or idempotency key reused with mismatched payload' },
            '422': { description: 'Insufficient funds or same-account transfer' },
            '429': { description: 'Transfer rate limit exceeded' },
          },
        },
      },
      '/api/transactions/{id}': {
        get: {
          summary: 'Get double-entry transaction detail (Participant or Admin)',
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Transaction detail' },
            '404': { description: 'Missing or non-participant transaction' },
          },
        },
      },
      '/api/transactions/{id}/reverse': {
        post: {
          summary: 'Admin: create compensating REVERSAL journal transaction without mutating originals',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '201': { description: 'Compensating reversal transaction created' },
            '409': { description: 'Already reversed, reversal target, or CLOSED account' },
            '422': { description: 'Insufficient funds on recipient account to reverse' },
          },
        },
      },
      '/api/admin/summary': {
        get: {
          summary: 'Admin: aggregate KPI counts for users, onboarding, accounts, transactions, audits',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Admin summary counters' } },
        },
      },
      '/api/admin/accounts': {
        post: {
          summary: 'Admin: provision a synthetic INR account for an APPROVED customer',
          security: [{ cookieAuth: [], csrfToken: [] }],
          responses: {
            '201': { description: 'Account created (and optionally funded via treasury adjustment)' },
            '409': { description: 'Customer onboarding not APPROVED or inactive user' },
          },
        },
      },
      '/api/admin/accounts/{id}/activate': {
        post: {
          summary: 'Admin: activate a PENDING synthetic account with mandatory reason',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Account activated' } },
        },
      },
      '/api/admin/accounts/{id}/freeze': {
        post: {
          summary: 'Admin: freeze an ACTIVE synthetic account with mandatory reason',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Account frozen' } },
        },
      },
      '/api/admin/accounts/{id}/unfreeze': {
        post: {
          summary: 'Admin: unfreeze a FROZEN synthetic account with mandatory reason',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Account unfrozen' } },
        },
      },
      '/api/admin/accounts/{id}/close': {
        post: {
          summary: 'Admin: close a zero-balance ACTIVE or FROZEN synthetic account with reason',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Account closed' },
            '409': { description: 'Account balance non-zero or invalid state transition' },
          },
        },
      },
      '/api/admin/users': {
        get: {
          summary: 'Admin: search, filter, and paginate users',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Paginated safe user summaries' } },
        },
      },
      '/api/admin/users/{id}': {
        get: {
          summary: 'Admin: inspect safe user detail',
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Safe user detail' } },
        },
      },
      '/api/admin/users/{id}/status': {
        patch: {
          summary: 'Admin/Super Admin: update user status (ACTIVE/DISABLED/LOCKED) with audit & session revocation',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'User status updated' } },
        },
      },
      '/api/admin/users/{id}/role': {
        patch: {
          summary: 'SUPER_ADMIN only: change user role with audit & session revocation',
          security: [{ cookieAuth: [], csrfToken: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Role updated' } },
        },
      },
      '/api/admin/audit-events': {
        get: {
          summary: 'Admin: filter and inspect read-only append-only AuditEvent log',
          security: [{ cookieAuth: [] }],
          responses: { '200': { description: 'Paginated redacted audit events' } },
        },
      },
    },
  };
}
