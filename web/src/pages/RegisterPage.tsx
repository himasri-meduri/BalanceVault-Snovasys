import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { ApiClientError } from '../lib/apiClient';
import { evaluatePasswordPolicy, isPasswordPolicySatisfied } from '../lib/validation';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const checklist = evaluatePasswordPolicy(password);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);

    const nextFieldErrors: Record<string, string> = {};
    const trimmedName = fullName.trim();
    const trimmedEmail = email.trim();

    if (trimmedName.length < 2 || trimmedName.length > 120) {
      nextFieldErrors.fullName = 'Full name must be between 2 and 120 characters.';
    }
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      nextFieldErrors.email = 'Please provide a valid email address.';
    }
    if (!isPasswordPolicySatisfied(password)) {
      nextFieldErrors.password =
        'Password must be 10–128 characters and include uppercase, lowercase, digit, and special character.';
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    try {
      await register({
        fullName: trimmedName,
        email: trimmedEmail,
        password,
      });
      setPassword('');
      navigate('/onboarding', { replace: true });
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
    <section className="bv-card bv-auth-card" aria-labelledby="register-heading">
      <div className="bv-card-header">
        <div>
          <h1 id="register-heading" className="bv-page-title">
            Customer Registration
          </h1>
          <p className="bv-card-subtitle">
            Public registration always creates a <code>CUSTOMER</code> account with a{' '}
            <code>PENDING</code> synthetic onboarding profile.
          </p>
        </div>
      </div>

      <form className="bv-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <ApiErrorAlert error={submitError} title="Registration failed" />

        <div className="bv-field">
          <label htmlFor="register-full-name">Full Name</label>
          <input
            id="register-full-name"
            name="fullName"
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            aria-invalid={Boolean(fieldErrors.fullName)}
            required
          />
          {fieldErrors.fullName ? (
            <p className="bv-field-error">{fieldErrors.fullName}</p>
          ) : null}
        </div>

        <div className="bv-field">
          <label htmlFor="register-email">Email Address</label>
          <input
            id="register-email"
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
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            required
          />
          {fieldErrors.password ? (
            <p className="bv-field-error">{fieldErrors.password}</p>
          ) : null}

          <ul className="bv-policy-list" aria-label="Password requirements">
            <li className={checklist.minLength && checklist.maxLength ? 'bv-ok' : ''}>
              10 to 128 characters
            </li>
            <li className={checklist.hasUpper ? 'bv-ok' : ''}>One uppercase letter</li>
            <li className={checklist.hasLower ? 'bv-ok' : ''}>One lowercase letter</li>
            <li className={checklist.hasDigit ? 'bv-ok' : ''}>One digit</li>
            <li className={checklist.hasSpecial ? 'bv-ok' : ''}>
              One special character
            </li>
          </ul>
        </div>

        <div className="bv-actions-row">
          <button
            type="submit"
            className="bv-button bv-button--primary"
            disabled={submitting}
          >
            {submitting ? 'Creating Account...' : 'Create Customer Account'}
          </button>
          <Link to="/login" className="bv-button bv-button--secondary">
            Already Registered? Sign In
          </Link>
        </div>
      </form>
    </section>
  );
}
