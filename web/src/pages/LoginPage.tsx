import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { ApiClientError } from '../lib/apiClient';
import { getDefaultHomePath, sanitizeInternalRedirectPath } from '../lib/format';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);

    const nextFieldErrors: Record<string, string> = {};
    if (!email.trim()) {
      nextFieldErrors.email = 'Please enter your email address.';
    }
    if (!password) {
      nextFieldErrors.password = 'Please enter your password.';
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    try {
      const authenticatedUser = await login({
        email: email.trim(),
        password,
      });
      setPassword('');

      const state = location.state as { from?: unknown } | null;
      const defaultHome = getDefaultHomePath(authenticatedUser.role);
      const destination = sanitizeInternalRedirectPath(state?.from, defaultHome);
      navigate(destination, { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        const mapped: Record<string, string> = {};
        for (const [key, messages] of Object.entries(err.fieldErrors)) {
          if (messages[0]) {
            mapped[key] = messages[0];
          }
        }
        setFieldErrors(mapped);
      }
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bv-card bv-auth-card" aria-labelledby="login-heading">
      <div className="bv-card-header">
        <div>
          <h1 id="login-heading" className="bv-page-title">
            Sign In
          </h1>
          <p className="bv-card-subtitle">
            Authenticate with your BalanceVault account (<code>bv_sid</code> HttpOnly
            session).
          </p>
        </div>
      </div>

      <form className="bv-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <ApiErrorAlert error={submitError} title="Sign in failed" />

        <div className="bv-field">
          <label htmlFor="login-email">Email Address</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(fieldErrors.email)}
            required
          />
          {fieldErrors.email ? (
            <p className="bv-field-error">{fieldErrors.email}</p>
          ) : null}
        </div>

        <div className="bv-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            required
          />
          {fieldErrors.password ? (
            <p className="bv-field-error">{fieldErrors.password}</p>
          ) : null}
        </div>

        <div className="bv-actions-row">
          <button
            type="submit"
            className="bv-button bv-button--primary"
            disabled={submitting}
          >
            {submitting ? 'Signing In...' : 'Sign In'}
          </button>
          <Link to="/register" className="bv-button bv-button--secondary">
            Need a Customer Account?
          </Link>
        </div>
      </form>
    </section>
  );
}
