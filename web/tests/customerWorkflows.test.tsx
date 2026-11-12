import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  apiErrorBody,
  installFetchMock,
  jsonResponse,
  makeAccount,
  makeCustomerOnboarding,
  makeLedgerEntry,
  makeSessionResponse,
  makeTransactionDetail,
  renderAppRoute,
} from './testHelpers';

describe('Customer dashboard, onboarding, accounts, ledger, and transfers', () => {
  it('renders Customer Dashboard with live onboarding state and live owned synthetic vaults summary', async () => {
    const onboardingApp = makeCustomerOnboarding({
      status: 'APPROVED',
      submittedAt: '2026-11-11T10:15:00.000Z',
      reviewedAt: '2026-11-11T10:30:00.000Z',
    });
    const account = makeAccount({
      accountName: 'Primary Synthetic Vault',
      balanceMinor: '500000',
    });

    installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          200,
          makeSessionResponse('CUSTOMER', 'csrf-1', { onboardingStatus: 'APPROVED' }),
        );
      }
      if (path === '/onboarding/me') {
        return jsonResponse(200, { application: onboardingApp, requestId: 'req-ob-1' });
      }
      if (path.startsWith('/accounts')) {
        return jsonResponse(200, {
          items: [account],
          total: 1,
          page: 1,
          pageSize: 10,
          requestId: 'req-acc-1',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/customer');

    await waitFor(() => {
      expect(screen.getByText('Primary Synthetic Vault')).toBeInTheDocument();
    });

    expect(screen.getByText('BV-A1B2C3D4E5F6')).toBeInTheDocument();
    expect(screen.getAllByText('₹5,000.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/BLOCKED/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Accounts & Transfers' }),
    ).toBeInTheDocument();
  });

  it('renders /accounts ledger, inspects redacted counterparty detail, and posts idempotent transfer with sticky Idempotency-Key', async () => {
    const onboardingApp = makeCustomerOnboarding({
      status: 'APPROVED',
      submittedAt: '2026-11-11T10:15:00.000Z',
      reviewedAt: '2026-11-11T11:00:00.000Z',
    });
    let account = makeAccount({ balanceMinor: '500000' });
    let ledger = [makeLedgerEntry({ direction: 'CREDIT', transactionType: 'ADJUSTMENT', counterpartyReference: 'BV-SYS-TREASURY-01', amountMinor: '500000', description: 'Opening synthetic allocation' })];
    const postTransferTxn = makeTransactionDetail({
      id: '77777777-7777-4777-8777-777777777777',
      publicReference: 'TXN-20261111-0099',
      amountMinor: '125050',
      description: 'Rent share synthetic payout',
    } as Record<string, unknown>);

    let failFirstTransferAttempt = true;

    const calls = installFetchMock(({ path, method, body }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          200,
          makeSessionResponse('CUSTOMER', 'csrf-xfer-88', { onboardingStatus: 'APPROVED' }),
        );
      }
      if (path === '/onboarding/me') {
        return jsonResponse(200, { application: onboardingApp, requestId: 'req-ob-1' });
      }
      if (path.startsWith('/accounts?') && method === 'GET') {
        return jsonResponse(200, {
          items: [account],
          total: 1,
          page: 1,
          pageSize: 50,
          requestId: 'req-acc-list',
        });
      }
      if (path.startsWith(`/accounts/${account.id}/ledger`) && method === 'GET') {
        return jsonResponse(200, {
          account,
          items: ledger,
          total: ledger.length,
          page: 1,
          pageSize: 20,
          requestId: 'req-ledger-1',
        });
      }
      if (path === `/transactions/${ledger[0]!.transactionId}` && method === 'GET') {
        return jsonResponse(200, {
          transaction: makeTransactionDetail({
            id: ledger[0]!.transactionId,
            entries: [
              {
                id: 'e1',
                accountId: account.id,
                accountPublicReference: account.publicReference,
                accountKind: 'CUSTOMER',
                accountName: account.accountName,
                direction: 'CREDIT',
                amountMinor: '500000',
                currency: 'INR',
              },
              {
                id: 'e2',
                accountId: null,
                accountPublicReference: 'BV-SYS-TREASURY-01',
                accountKind: 'SYSTEM_ISSUANCE',
                accountName: null,
                direction: 'DEBIT',
                amountMinor: '500000',
                currency: 'INR',
              },
            ],
          }),
          requestId: 'req-txn-1',
        });
      }
      if (path === '/transfers' && method === 'POST') {
        if (failFirstTransferAttempt) {
          failFirstTransferAttempt = false;
          return jsonResponse(
            503,
            apiErrorBody({
              code: 'SERVICE_UNAVAILABLE',
              message: 'Transient timeout; retry with same Idempotency-Key',
            }),
          );
        }
        const payload = body as { amountMinor: string; description: string };
        account = { ...account, balanceMinor: '374950' };
        ledger = [
          makeLedgerEntry({
            id: 'entry-new-2',
            transactionId: postTransferTxn.id,
            transactionPublicReference: postTransferTxn.publicReference,
            direction: 'DEBIT',
            amountMinor: payload.amountMinor,
            description: payload.description,
          }),
          ...ledger,
        ];
        return jsonResponse(201, {
          transaction: postTransferTxn,
          sourceAccount: account,
          idempotentReplay: false,
          requestId: 'req-xfer-ok',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/accounts');

    await waitFor(() => {
      expect(screen.getByText('Opening synthetic allocation')).toBeInTheDocument();
    });

    // Inspect ledger transaction and verify redacted counterparty details
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => {
      expect(screen.getByText('Counterparty details redacted')).toBeInTheDocument();
    });

    // Prepare simulated transfer
    fireEvent.change(screen.getByLabelText('Destination Account Reference'), {
      target: { value: 'bv-9988776655aa' },
    });
    fireEvent.change(screen.getByLabelText('Amount (INR, max ₹1,00,00,000.00)'), {
      target: { value: '1250.50' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Rent share synthetic payout' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review Transfer' }));

    expect(screen.getByText('Confirm Simulated Transfer')).toBeInTheDocument();

    // First attempt returns transient 503; retry must send IDENTICAL Idempotency-Key and CSRF token
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Send Transfer' }));
    await waitFor(() => {
      expect(screen.getByText(/Code: SERVICE_UNAVAILABLE/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry Transfer' }));
    await waitFor(() => {
      expect(
        screen.getByText(/Transfer TXN-20261111-0099 posted for ₹1,250\.50/i),
      ).toBeInTheDocument();
    });

    const transferCalls = calls.filter((c) => c.path === '/transfers');
    expect(transferCalls).toHaveLength(2);
    expect(transferCalls[0]!.headers.get('X-CSRF-Token')).toBe('csrf-xfer-88');
    expect(transferCalls[0]!.headers.get('Idempotency-Key')).toBeTruthy();
    expect(transferCalls[0]!.headers.get('Idempotency-Key')).toBe(
      transferCalls[1]!.headers.get('Idempotency-Key'),
    );
    expect((transferCalls[1]!.body as { amountMinor: string }).amountMinor).toBe(
      '125050',
    );
    expect(
      (transferCalls[1]!.body as { destinationAccountReference: string })
        .destinationAccountReference,
    ).toBe('BV-9988776655AA');
  });

  it('allows unsubmitted customer to validate, save draft (PATCH), submit (POST), and locks after submission', async () => {
    let currentApp = makeCustomerOnboarding({
      status: 'PENDING',
      submittedAt: null,
    });

    const calls = installFetchMock(({ path, method, body }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          200,
          makeSessionResponse('CUSTOMER', 'csrf-cust-99', {
            onboardingStatus: currentApp.status,
          }),
        );
      }
      if (path === '/onboarding/me' && method === 'GET') {
        return jsonResponse(200, { application: currentApp, requestId: 'req-get' });
      }
      if (path === '/onboarding/me' && method === 'PATCH') {
        const patch = body as Record<string, unknown>;
        currentApp = {
          ...currentApp,
          ...patch,
        };
        return jsonResponse(200, { application: currentApp, requestId: 'req-patch' });
      }
      if (path === '/onboarding/me/submit' && method === 'POST') {
        const payload = body as Record<string, unknown>;
        currentApp = {
          ...currentApp,
          ...payload,
          status: 'PENDING',
          submittedAt: '2026-11-11T10:30:00.000Z',
        };
        return jsonResponse(200, { application: currentApp, requestId: 'req-sub' });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/onboarding');

    await waitFor(() => {
      expect(screen.getByLabelText('Synthetic Contact Reference')).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }));
    expect(screen.getByText(/Contact reference is required/i)).toBeInTheDocument();
    expect(
      screen.getByText(/You must accept the synthetic demonstration terms/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Synthetic Contact Reference'), {
      target: { value: '+91-90000-00001' },
    });
    fireEvent.change(screen.getByLabelText('City'), {
      target: { value: 'Bengaluru' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));

    await waitFor(() => {
      expect(screen.getByText('Onboarding profile draft saved.')).toBeInTheDocument();
    });

    const patchCall = calls.find((c) => c.path === '/onboarding/me' && c.method === 'PATCH');
    expect(patchCall?.headers.get('X-CSRF-Token')).toBe('csrf-cust-99');

    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'India' },
    });
    fireEvent.change(screen.getByLabelText('Account Purpose'), {
      target: { value: 'Testing synthetic INR ledger inflows and outflows' },
    });
    fireEvent.click(
      screen.getByLabelText(/I acknowledge this is a synthetic demonstration environment/i),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }));

    await waitFor(() => {
      expect(
        screen.getByText('Onboarding application submitted for administrator review.'),
      ).toBeInTheDocument();
    });

    const submitCall = calls.find((c) => c.path === '/onboarding/me/submit');
    expect(submitCall?.headers.get('X-CSRF-Token')).toBe('csrf-cust-99');
    expect(screen.getByLabelText('Synthetic Contact Reference')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Submit for Review' }),
    ).not.toBeInTheDocument();
  });

  it('supports reopening and direct resubmission when application is REJECTED', async () => {
    let currentApp = makeCustomerOnboarding({
      status: 'REJECTED',
      contactReference: 'DEMO-REF-01',
      city: 'Pune',
      country: 'India',
      accountPurpose: 'Old synthetic purpose',
      acceptedSyntheticTerms: true,
      submittedAt: '2026-11-11T09:00:00.000Z',
      reviewedAt: '2026-11-11T09:30:00.000Z',
      reviewReason: 'Please clarify expected synthetic transaction usage',
    });

    const calls = installFetchMock(({ path, method, body }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          200,
          makeSessionResponse('CUSTOMER', 'csrf-rej-1', {
            onboardingStatus: currentApp.status,
          }),
        );
      }
      if (path === '/onboarding/me' && method === 'GET') {
        return jsonResponse(200, { application: currentApp, requestId: 'req-get' });
      }
      if (path === '/onboarding/me/submit' && method === 'POST') {
        const payload = body as Record<string, unknown>;
        currentApp = {
          ...currentApp,
          ...payload,
          status: 'PENDING',
          submittedAt: '2026-11-11T10:45:00.000Z',
          reviewedAt: null,
          reviewReason: null,
        };
        return jsonResponse(200, { application: currentApp, requestId: 'req-resub' });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/onboarding');

    await waitFor(() => {
      expect(
        screen.getByText(/Please clarify expected synthetic transaction usage/i),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Account Purpose')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit & Resubmit Directly' }));

    expect(screen.getByLabelText('Account Purpose')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Account Purpose'), {
      target: { value: 'Updated synthetic ledger demo savings and transfers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resubmit Application' }));

    await waitFor(() => {
      expect(
        screen.getByText('Onboarding application submitted for administrator review.'),
      ).toBeInTheDocument();
    });

    const submitCall = calls.find((c) => c.path === '/onboarding/me/submit');
    expect((submitCall?.body as { resubmit?: boolean }).resubmit).toBe(true);
    expect(submitCall?.headers.get('X-CSRF-Token')).toBe('csrf-rej-1');
  });
});
