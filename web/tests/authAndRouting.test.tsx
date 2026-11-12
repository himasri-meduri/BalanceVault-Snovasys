import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sanitizeInternalRedirectPath } from '../src/lib/format';
import {
  apiErrorBody,
  installFetchMock,
  jsonResponse,
  makeCustomerOnboarding,
  makeSessionResponse,
  renderAppRoute,
} from './testHelpers';

describe('BalanceVault auth, CSRF, and role-aware routing', () => {
  it('renders Foundation Overview, live health/ready status, and synthetic demo banner when logged out', async () => {
    const calls = installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          401,
          apiErrorBody({ code: 'UNAUTHORIZED', message: 'Not signed in' }),
        );
      }
      if (path === '/health') {
        return jsonResponse(200, {
          status: 'ok',
          service: 'balancevault-api',
          timestamp: '2026-11-11T10:00:00.000Z',
          requestId: 'req-h1',
        });
      }
      if (path === '/ready') {
        return jsonResponse(200, {
          status: 'ready',
          checks: { database: 'ok', redis: 'ok' },
          timestamp: '2026-11-11T10:00:00.000Z',
          requestId: 'req-r1',
        });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/');

    expect(
      screen.getByText(/Demo environment — synthetic data only/i),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('READY')).toBeInTheDocument();
    });
    expect(screen.getAllByText('OK').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('link', { name: 'Create Customer Account' })).toBeInTheDocument();

    const meCall = calls.find((c) => c.path === '/auth/me');
    expect(meCall?.credentials).toBe('include');
    expect(meCall?.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('authenticates via POST /api/auth/login with credentials, stores CSRF only in memory, and sends X-CSRF-Token on logout', async () => {
    const onboardingApp = makeCustomerOnboarding();
    const calls = installFetchMock(({ path, method }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          401,
          apiErrorBody({ code: 'UNAUTHORIZED', message: 'Session required' }),
        );
      }
      if (path === '/auth/login' && method === 'POST') {
        return jsonResponse(200, makeSessionResponse('CUSTOMER', 'csrf-login-abc'));
      }
      if (path === '/onboarding/me' && method === 'GET') {
        return jsonResponse(200, { application: onboardingApp, requestId: 'req-ob-1' });
      }
      if (path.startsWith('/accounts') && method === 'GET') {
        return jsonResponse(200, {
          items: [],
          total: 0,
          page: 1,
          pageSize: 10,
          requestId: 'req-acc-0',
        });
      }
      if (path === '/auth/logout' && method === 'POST') {
        return jsonResponse(200, { loggedOut: true, requestId: 'req-logout-1' });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/login');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'asha.rao@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'StrongPass#123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Customer Dashboard' }),
      ).toBeInTheDocument();
    });

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    });

    const logoutCall = calls.find((c) => c.path === '/auth/logout');
    expect(logoutCall?.credentials).toBe('include');
    expect(logoutCall?.headers.get('X-CSRF-Token')).toBe('csrf-login-abc');
  });

  it('validates registration policy client-side, handles 409 conflicts, and navigates new customers to /onboarding', async () => {
    let conflictOnFirst = true;
    const onboardingApp = makeCustomerOnboarding();

    installFetchMock(({ path, method }) => {
      if (path === '/auth/me') {
        return jsonResponse(
          401,
          apiErrorBody({ code: 'UNAUTHORIZED', message: 'Not signed in' }),
        );
      }
      if (path === '/auth/register' && method === 'POST') {
        if (conflictOnFirst) {
          conflictOnFirst = false;
          return jsonResponse(
            409,
            apiErrorBody({
              code: 'EMAIL_ALREADY_EXISTS',
              message: 'An account with this email already exists',
              requestId: 'req-reg-409',
            }),
          );
        }
        return jsonResponse(201, makeSessionResponse('CUSTOMER', 'csrf-reg-1'));
      }
      if (path === '/onboarding/me' && method === 'GET') {
        return jsonResponse(200, { application: onboardingApp, requestId: 'req-ob-1' });
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/register');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Customer Registration' }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Full Name'), {
      target: { value: 'Asha Rao' },
    });
    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'asha.rao@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'weak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer Account' }));

    expect(
      screen.getByText(/Password must be 10–128 characters/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'ValidPass#2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer Account' }));

    await waitFor(() => {
      expect(
        screen.getByText(/An account with this email already exists/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Code: EMAIL_ALREADY_EXISTS/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create Customer Account' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Customer Onboarding Application' }),
      ).toBeInTheDocument();
    });
  });

  it('enforces role-aware navigation and blocks cross-role route access', async () => {
    installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('CUSTOMER'));
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/admin/users');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Access Denied' })).toBeInTheDocument();
    });
    expect(screen.getByText(/ADMIN or SUPER_ADMIN/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Events' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('blocks ADMIN users from customer-only onboarding routes cleanly', async () => {
    installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('ADMIN'));
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/onboarding');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Access Denied' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Admin Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
  });

  it('clears auth state and shows session expiry notice when a mid-session request returns 401', async () => {
    let onboardingCalls = 0;
    const onboardingApp = makeCustomerOnboarding();

    installFetchMock(({ path }) => {
      if (path === '/auth/me') {
        return jsonResponse(200, makeSessionResponse('CUSTOMER'));
      }
      if (path === '/onboarding/me') {
        onboardingCalls += 1;
        if (onboardingCalls === 1) {
          return jsonResponse(200, { application: onboardingApp, requestId: 'req-ob-1' });
        }
        return jsonResponse(
          401,
          apiErrorBody({ code: 'UNAUTHORIZED', message: 'Session revoked' }),
        );
      }
      if (path.startsWith('/accounts')) {
        if (onboardingCalls <= 1) {
          return jsonResponse(200, {
            items: [],
            total: 0,
            page: 1,
            pageSize: 10,
            requestId: 'req-acc-0',
          });
        }
        return jsonResponse(
          401,
          apiErrorBody({ code: 'UNAUTHORIZED', message: 'Session revoked' }),
        );
      }
      return jsonResponse(404, apiErrorBody({ code: 'NOT_FOUND', message: 'Not found' }));
    });

    renderAppRoute('/customer');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Customer Dashboard' }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your session expired or was revoked. Please sign in again./i),
    ).toBeInTheDocument();
  });

  it('sanitizes internal redirect paths to prevent open redirects', () => {
    expect(sanitizeInternalRedirectPath('/onboarding', '/customer')).toBe('/onboarding');
    expect(sanitizeInternalRedirectPath('//evil.example/phish', '/customer')).toBe(
      '/customer',
    );
    expect(sanitizeInternalRedirectPath('https://evil.example', '/customer')).toBe(
      '/customer',
    );
  });
});
