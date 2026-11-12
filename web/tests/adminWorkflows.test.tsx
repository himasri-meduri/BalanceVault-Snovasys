import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminUserItem } from '../src/lib/types';
import {
  apiErrorBody,
  installFetchMock,
  jsonResponse,
  makeAccount,
  makeAdminOnboarding,
  makeAdminSummary,
  makeAuditEvent,
  makeLedgerEntry,
  makeSessionResponse,
  makeTransactionDetail,
  renderAppRoute,
} from './testHelpers';

describe('Admin dashboard, onboarding review, accounts & reversals, users/status/roles, and audit viewer', () => {
  it('renders Admin Dashboard metrics from GET /api/admin/summary with live accounts & transactions totals', async () => {
    const pendingApp = makeAdminOnboarding();
    const auditItem = makeAuditEvent();
    const summary = makeAdminSummary();

    installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('ADMIN'));
      }
      if (path === '/admin/summary') {
        return jsonResponse(200, summary);
      }
      if (path.startsWith('/admin/onboarding/applications?status=PENDING')) {
        return jsonResponse(200, {
          items: [pendingApp],
          page: 1,
          pageSize: 5,
          total: 3,
          requestId: 'req-1',
        });
      }
      if (path.startsWith('/admin/audit-events')) {
        return jsonResponse(200, {
          items: [auditItem],
          page: 1,
          pageSize: 5,
          total: 25,
          requestId: 'req-5',
        });
      }
      if (path === '/health') {
        return jsonResponse(200, {
          status: 'ok',
          service: 'balancevault-api',
          timestamp: '2026-11-11T10:00:00.000Z',
          requestId: 'req-h',
        });
      }
      if (path === '/ready') {
        return jsonResponse(200, {
          status: 'ready',
          checks: { database: 'ok', redis: 'ok' },
          timestamp: '2026-11-11T10:00:00.000Z',
          requestId: 'req-r',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/admin');

    await waitFor(() => {
      expect(screen.getByText('25')).toBeInTheDocument();
    });
    expect(screen.getByText('6 / 1')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('ONBOARDING_APPROVED')).toBeInTheDocument();
    expect(screen.queryByText(/BLOCKED/i)).not.toBeInTheDocument();
  });

  it('prevents approving unsubmitted PENDING applications, approves submitted ones with CSRF, and enforces reject reason confirmation', async () => {
    let submittedApp = makeAdminOnboarding({
      id: 'app-submitted-1',
      applicant: {
        id: 'u-1',
        fullName: 'Asha Rao',
        email: 'asha.rao@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    });
    const unsubmittedApp = makeAdminOnboarding({
      id: 'app-unsubmitted-2',
      submittedAt: null,
      acceptedSyntheticTerms: false,
      city: null,
      country: null,
      accountPurpose: null,
      contactReference: null,
      applicant: {
        id: 'u-2',
        fullName: 'Rohan Draft',
        email: 'rohan.draft@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    });

    const calls = installFetchMock(({ path, method }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('ADMIN', 'csrf-admin-1'));
      }
      if (path.startsWith('/admin/onboarding/applications?')) {
        return jsonResponse(200, {
          items: [submittedApp, unsubmittedApp],
          page: 1,
          pageSize: 20,
          total: 2,
          requestId: 'req-list',
        });
      }
      if (path === '/admin/onboarding/applications/app-submitted-1' && method === 'GET') {
        return jsonResponse(200, { application: submittedApp, requestId: 'req-d1' });
      }
      if (
        path === '/admin/onboarding/applications/app-unsubmitted-2' &&
        method === 'GET'
      ) {
        return jsonResponse(200, { application: unsubmittedApp, requestId: 'req-d2' });
      }
      if (
        path === '/admin/onboarding/applications/app-submitted-1/approve' &&
        method === 'POST'
      ) {
        submittedApp = {
          ...submittedApp,
          status: 'APPROVED',
          reviewedAt: '2026-11-11T12:00:00.000Z',
          reviewReason: 'Verified synthetic demo fields',
        };
        return jsonResponse(200, { application: submittedApp, requestId: 'req-app' });
      }
      if (
        path === '/admin/onboarding/applications/app-unsubmitted-2/reject' &&
        method === 'POST'
      ) {
        return jsonResponse(
          409,
          apiErrorBody({
            code: 'INVALID_STATE_TRANSITION',
            message: 'Application was already reviewed by another concurrent request',
            requestId: 'req-409',
          }),
        );
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/admin/onboarding');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve Application' })).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByLabelText('Approval Reason (optional, min 3 chars if entered)'),
      { target: { value: 'Verified synthetic demo fields' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve Application' }));

    await waitFor(() => {
      expect(
        screen.getByText('Application for Asha Rao approved and audited.'),
      ).toBeInTheDocument();
    });

    const approveCall = calls.find((c) => c.path.endsWith('/approve'));
    expect(approveCall?.headers.get('X-CSRF-Token')).toBe('csrf-admin-1');

    fireEvent.click(screen.getByRole('button', { name: /Rohan Draft/i }));

    await waitFor(() => {
      expect(screen.getByText(/not yet submitted/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'Approve Application' }),
    ).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText('Rejection Reason (required, 10–500 characters)'),
      { target: { value: 'short' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject Application' }));
    expect(
      screen.getByText('Rejection reason must be between 10 and 500 characters.'),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText('Rejection Reason (required, 10–500 characters)'),
      { target: { value: 'Incomplete onboarding application never submitted' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject Application' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rejection' }));

    await waitFor(() => {
      expect(screen.getByText(/Code: INVALID_STATE_TRANSITION/i)).toBeInTheDocument();
    });
  });

  it('provisions customer synthetic accounts, transitions lifecycle state, and posts compensating reversals on /admin/accounts', async () => {
    const customerUser: AdminUserItem = {
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'Asha Rao',
      email: 'asha.rao@example.com',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      onboardingStatus: 'APPROVED',
      createdAt: '2026-11-11T10:00:00.000Z',
    };
    let account = makeAccount({
      owner: {
        id: customerUser.id,
        fullName: customerUser.fullName,
        email: customerUser.email,
        status: 'ACTIVE',
        onboardingStatus: 'APPROVED',
      },
    });
    const ledgerEntry = makeLedgerEntry({
      transactionId: '55555555-5555-4555-8555-555555555555',
      transactionPublicReference: 'TXN-20261111-0001',
    });
    let txnDetail = makeTransactionDetail();

    const calls = installFetchMock(({ path, method, body }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('ADMIN', 'csrf-acc-admin'));
      }
      if (path.startsWith('/admin/users')) {
        return jsonResponse(200, {
          items: [customerUser],
          total: 1,
          page: 1,
          pageSize: 50,
          requestId: 'req-u',
        });
      }
      if (path.startsWith('/accounts?') && method === 'GET') {
        return jsonResponse(200, {
          items: [account],
          total: 1,
          page: 1,
          pageSize: 20,
          requestId: 'req-a-list',
        });
      }
      if (path.startsWith(`/accounts/${account.id}/ledger`) && method === 'GET') {
        return jsonResponse(200, {
          account,
          items: [ledgerEntry],
          total: 1,
          page: 1,
          pageSize: 15,
          requestId: 'req-led',
        });
      }
      if (path === '/admin/accounts' && method === 'POST') {
        const payload = body as { accountName: string; initialCreditMinor: string };
        const created = makeAccount({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          publicReference: 'BV-NEWVAULT9999',
          accountName: payload.accountName,
          balanceMinor: payload.initialCreditMinor,
        });
        account = created;
        return jsonResponse(201, {
          account: created,
          openingTransaction: null,
          requestId: 'req-create',
        });
      }
      if (path === `/admin/accounts/${account.id}/freeze` && method === 'POST') {
        account = { ...account, status: 'FROZEN', statusReason: 'Hold checked' };
        return jsonResponse(200, { account, requestId: 'req-freeze' });
      }
      if (path === `/transactions/${txnDetail.id}` && method === 'GET') {
        return jsonResponse(200, { transaction: txnDetail, requestId: 'req-txn' });
      }
      if (path === `/transactions/${txnDetail.id}/reverse` && method === 'POST') {
        txnDetail = {
          ...txnDetail,
          status: 'REVERSED',
          reversedByTransactionId: '88888888-8888-4888-8888-888888888888',
          reversedByPublicReference: 'TXN-20261111-REV1',
        };
        return jsonResponse(201, {
          reversalTransaction: {
            ...txnDetail,
            id: '88888888-8888-4888-8888-888888888888',
            publicReference: 'TXN-20261111-REV1',
            type: 'REVERSAL',
            status: 'POSTED',
          },
          reversedTransactionId: txnDetail.id,
          reversedTransactionStatus: 'REVERSED',
          requestId: 'req-rev',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/admin/accounts');

    await waitFor(() => {
      expect(screen.getAllByText('BV-A1B2C3D4E5F6').length).toBeGreaterThanOrEqual(1);
    });

    // Provision new account
    fireEvent.change(screen.getByLabelText('Account Label'), {
      target: { value: 'Customer Second Reserve' },
    });
    fireEvent.change(screen.getByLabelText('Opening Synthetic Allocation (INR)'), {
      target: { value: '2500' },
    });
    fireEvent.change(
      screen.getByLabelText('Provisioning Audit Reason (required, 5–500 chars)'),
      { target: { value: 'Approved initial synthetic allocation' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create Synthetic Account' }));

    await waitFor(() => {
      expect(screen.getByText(/Created Customer Second Reserve/i)).toBeInTheDocument();
    });

    // Freeze account with two-step confirmation
    fireEvent.change(
      screen.getByLabelText(
        'Lifecycle Audit Reason (min 5 chars; min 10 chars for Freeze / Close)',
      ),
      { target: { value: 'Operational freeze check required' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Freeze Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm FREEZE' }));

    await waitFor(() => {
      expect(screen.getByText(/status to FROZEN/i)).toBeInTheDocument();
    });

    // Inspect ledger entry & issue compensating reversal
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => {
      expect(screen.getByText('Issue Compensating Reversal')).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByLabelText('Compensating Reversal Reason (required, 10–500 chars)'),
      { target: { value: 'Reversing synthetic settlement for audit check' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review Reversal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reversal' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Posted compensating reversal TXN-20261111-REV1/i),
      ).toBeInTheDocument();
    });

    const revCall = calls.find((c) => c.path.endsWith('/reverse'));
    expect(revCall?.headers.get('X-CSRF-Token')).toBe('csrf-acc-admin');
  });

  it('supports user search/detail/status governance and restricts role editing on /admin/users to SUPER_ADMIN', async () => {
    const directoryUsers: AdminUserItem[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        fullName: 'Asha Rao',
        email: 'asha.rao@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        onboardingStatus: 'APPROVED',
        createdAt: '2026-11-11T10:00:00.000Z',
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        fullName: 'Root Super Admin',
        email: 'superadmin@balancevault.local',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        onboardingStatus: null,
        createdAt: '2026-11-11T08:00:00.000Z',
        updatedAt: '2026-11-11T08:00:00.000Z',
      },
    ];

    let activeRole: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN';
    const calls = installFetchMock(({ path, method, body }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse(activeRole, 'csrf-super-77'));
      }
      if (path.startsWith('/admin/users?')) {
        return jsonResponse(200, {
          items: directoryUsers,
          page: 1,
          pageSize: 20,
          total: directoryUsers.length,
          requestId: 'req-users',
        });
      }
      if (path === '/admin/users/11111111-1111-4111-8111-111111111111' && method === 'GET') {
        return jsonResponse(200, {
          user: {
            ...directoryUsers[0],
            updatedAt: '2026-11-11T10:05:00.000Z',
            accountCount: 2,
            activeAccountCount: 1,
            onboardingSubmittedAt: '2026-11-11T10:02:00.000Z',
            onboardingReviewedAt: '2026-11-11T10:05:00.000Z',
            onboardingReviewReason: 'Approved synthetic test applicant',
          },
          requestId: 'req-user-detail',
        });
      }
      if (
        path === '/admin/users/11111111-1111-4111-8111-111111111111/status' &&
        method === 'PATCH'
      ) {
        const payload = body as { status: 'DISABLED'; reason: string };
        directoryUsers[0] = { ...directoryUsers[0]!, status: payload.status };
        return jsonResponse(200, {
          user: directoryUsers[0],
          requestId: 'req-status-ok',
        });
      }
      if (
        path === '/admin/users/11111111-1111-4111-8111-111111111111/role' &&
        method === 'PATCH'
      ) {
        const payload = body as { role: 'ADMIN'; reason: string };
        directoryUsers[0] = { ...directoryUsers[0]!, role: payload.role };
        return jsonResponse(200, {
          user: directoryUsers[0],
          requestId: 'req-role-ok',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    const firstRender = renderAppRoute('/admin/users');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'User Directory' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Change Role' })).not.toBeInTheDocument();

    // ADMIN can inspect user detail & change CUSTOMER status
    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect' })[0]!);
    await waitFor(() => {
      expect(screen.getByText('Provisioned Synthetic Accounts')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Change Status' })[0]!);
    fireEvent.change(
      screen.getByLabelText('Status Audit Reason (required, 5–500 chars)'),
      { target: { value: 'Suspending test customer sessions' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review Status Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Status Change' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Updated Asha Rao status to DISABLED and revoked active sessions/i),
      ).toBeInTheDocument();
    });
    firstRender.unmount();

    activeRole = 'SUPER_ADMIN';
    renderAppRoute('/admin/users');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'User & Role Management' }),
      ).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole('button', { name: 'Change Role' });
    fireEvent.click(editButtons[0]!);

    fireEvent.change(screen.getByLabelText('New Role'), {
      target: { value: 'ADMIN' },
    });
    fireEvent.change(screen.getByLabelText('Audit Reason (required, 5–500 chars)'), {
      target: { value: 'Promoting verified operator for onboarding reviews' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Role Change' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Updated Asha Rao role to ADMIN and revoked active user sessions/i),
      ).toBeInTheDocument();
    });

    const roleCall = calls.find((c) => c.path.endsWith('/role'));
    expect(roleCall?.headers.get('X-CSRF-Token')).toBe('csrf-super-77');
  });

  it('filters read-only audit events with date bounds, validates actor UUID, and inspects state diff JSON', async () => {
    const auditEvent = makeAuditEvent();

    const calls = installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('ADMIN'));
      }
      if (path.startsWith('/admin/audit-events')) {
        return jsonResponse(200, {
          items: [auditEvent],
          page: 1,
          pageSize: 20,
          total: 1,
          requestId: 'req-aud',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/admin/audit');

    await waitFor(() => {
      expect(screen.getByText('ONBOARDING_APPROVED')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Actor User UUID'), {
      target: { value: 'not-a-uuid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(
      screen.getByText('Actor User ID filter must be a valid UUID.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Actor User UUID'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'ONBOARDING_APPROVED' },
    });
    fireEvent.change(screen.getByLabelText('From Date'), {
      target: { value: '2026-11-10' },
    });
    fireEvent.change(screen.getByLabelText('To Date'), {
      target: { value: '2026-11-12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.path.includes('action=ONBOARDING_APPROVED') &&
            c.path.includes('from=2026-11-10') &&
            c.path.includes('to=2026-11-12'),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getByText('Before State')).toBeInTheDocument();
    expect(screen.getByText('After State')).toBeInTheDocument();
    expect(screen.getByText('req-audit-1')).toBeInTheDocument();
  });
});
