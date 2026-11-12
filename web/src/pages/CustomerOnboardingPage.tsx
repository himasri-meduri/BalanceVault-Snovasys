import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { StatusBadge } from '../components/StatusBadge';
import { onboardingApi } from '../lib/api';
import { ApiClientError } from '../lib/apiClient';
import {
  canCustomerEditOnboarding,
  describeOnboardingStage,
  formatDateTime,
} from '../lib/format';
import type { CustomerOnboardingApplication } from '../lib/types';
import {
  validateOnboardingFieldsForDraft,
  validateOnboardingFieldsForSubmit,
  type OnboardingFormValues,
} from '../lib/validation';

function toFormValues(app: CustomerOnboardingApplication): OnboardingFormValues {
  return {
    contactReference: app.contactReference ?? '',
    city: app.city ?? '',
    country: app.country ?? '',
    accountPurpose: app.accountPurpose ?? '',
    acceptedSyntheticTerms: app.acceptedSyntheticTerms,
  };
}

export function CustomerOnboardingPage() {
  const { refreshSession } = useAuth();
  const [loading, setLoading] = useState(true);
  const [application, setApplication] =
    useState<CustomerOnboardingApplication | null>(null);
  const [form, setForm] = useState<OnboardingFormValues>({
    contactReference: '',
    city: '',
    country: '',
    accountPurpose: '',
    acceptedSyntheticTerms: false,
  });
  const [directResubmitMode, setDirectResubmitMode] = useState(false);

  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    'save' | 'submit' | 'reopen' | null
  >(null);

  const syncFromResponse = useCallback(
    (app: CustomerOnboardingApplication) => {
      setApplication(app);
      setForm(toFormValues(app));
      if (app.status !== 'REJECTED') {
        setDirectResubmitMode(false);
      }
    },
    [],
  );

  const loadApplication = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await onboardingApi.getOwn();
      syncFromResponse(res.application);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [syncFromResponse]);

  useEffect(() => {
    void loadApplication();
  }, [loadApplication]);

  const mapServerFieldErrors = (err: unknown) => {
    if (err instanceof ApiClientError && err.fieldErrors) {
      const mapped: Record<string, string> = {};
      for (const [key, messages] of Object.entries(err.fieldErrors)) {
        if (messages[0]) {
          mapped[key] = messages[0];
        }
      }
      setFieldErrors(mapped);
    }
  };

  const handleSaveDraft = async () => {
    if (!application) return;
    setActionError(null);
    setSuccessMessage(null);

    const nextErrors = validateOnboardingFieldsForDraft(form);
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    const payload: {
      contactReference?: string;
      city?: string;
      country?: string;
      accountPurpose?: string;
      acceptedSyntheticTerms?: boolean;
    } = {};

    if (form.contactReference.trim()) {
      payload.contactReference = form.contactReference.trim();
    }
    if (form.city.trim()) {
      payload.city = form.city.trim();
    }
    if (form.country.trim()) {
      payload.country = form.country.trim();
    }
    if (form.accountPurpose.trim()) {
      payload.accountPurpose = form.accountPurpose.trim();
    }
    if (
      form.acceptedSyntheticTerms !== application.acceptedSyntheticTerms ||
      Object.keys(payload).length === 0
    ) {
      if (
        form.acceptedSyntheticTerms !== application.acceptedSyntheticTerms ||
        form.acceptedSyntheticTerms
      ) {
        payload.acceptedSyntheticTerms = form.acceptedSyntheticTerms;
      }
    }

    if (Object.keys(payload).length === 0) {
      setFieldErrors({
        form: 'Enter at least one profile field or toggle synthetic terms acceptance before saving.',
      });
      return;
    }

    setFieldErrors({});
    setBusyAction('save');

    try {
      const res = await onboardingApi.updateOwn(payload);
      syncFromResponse(res.application);
      setSuccessMessage('Onboarding profile draft saved.');
      void refreshSession();
    } catch (err) {
      mapServerFieldErrors(err);
      setActionError(err);
    } finally {
      setBusyAction(null);
    }
  };

  const handleReopenRejected = async () => {
    setActionError(null);
    setSuccessMessage(null);
    setFieldErrors({});
    setBusyAction('reopen');

    try {
      const res = await onboardingApi.updateOwn({ reopenForResubmission: true });
      syncFromResponse(res.application);
      setSuccessMessage(
        'Application reopened as DRAFT. Update your profile fields and submit for review.',
      );
      void refreshSession();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!application) return;

    setActionError(null);
    setSuccessMessage(null);

    const nextErrors = validateOnboardingFieldsForSubmit(form);
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    setFieldErrors({});
    setBusyAction('submit');

    try {
      const res = await onboardingApi.submitOwn({
        contactReference: form.contactReference.trim(),
        city: form.city.trim(),
        country: form.country.trim(),
        accountPurpose: form.accountPurpose.trim(),
        acceptedSyntheticTerms: true,
        ...(application.status === 'REJECTED' ? { resubmit: true } : {}),
      });
      syncFromResponse(res.application);
      setSuccessMessage(
        'Onboarding application submitted for administrator review.',
      );
      void refreshSession();
    } catch (err) {
      mapServerFieldErrors(err);
      setActionError(err);
    } finally {
      setBusyAction(null);
    }
  };

  const isEditable = application
    ? canCustomerEditOnboarding(application) ||
      (application.status === 'REJECTED' && directResubmitMode)
    : false;
  const isLockedPendingReview =
    application?.status === 'PENDING' && application.submittedAt !== null;
  const isApproved = application?.status === 'APPROVED';

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <h1>Customer Onboarding Application</h1>
        <p>
          Complete your synthetic profile details and accept the synthetic demonstration
          terms to submit for administrator approval.
        </p>
      </section>

      {loading ? (
        <section className="bv-card" aria-busy="true" aria-label="Loading onboarding">
          <div className="bv-skeleton-stack">
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
          </div>
        </section>
      ) : loadError ? (
        <section className="bv-card">
          <ApiErrorAlert error={loadError} title="Unable to load onboarding record" />
          <div className="bv-actions-row bv-mt-sm">
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => void loadApplication()}
            >
              Retry
            </button>
          </div>
        </section>
      ) : application ? (
        <div className="bv-stack-lg">
          <section className="bv-card" aria-labelledby="onboarding-status-heading">
            <div className="bv-card-header">
              <div>
                <h2 id="onboarding-status-heading" className="bv-card-title">
                  Application Status
                </h2>
                <p className="bv-card-subtitle">
                  {describeOnboardingStage(application)}
                </p>
              </div>
              <div className="bv-actions-row">
                <StatusBadge value={application.status} />
                <button
                  type="button"
                  className="bv-button bv-button--secondary"
                  onClick={() => void loadApplication()}
                  disabled={loading || busyAction !== null}
                >
                  Refresh
                </button>
              </div>
            </div>

            <dl className="bv-kv-grid">
              <div className="bv-kv-item">
                <dt>Applicant</dt>
                <dd>
                  {application.applicant.fullName} ({application.applicant.email})
                </dd>
              </div>
              <div className="bv-kv-item">
                <dt>Last Updated</dt>
                <dd>{formatDateTime(application.updatedAt)}</dd>
              </div>
              <div className="bv-kv-item">
                <dt>Submitted At</dt>
                <dd>{formatDateTime(application.submittedAt)}</dd>
              </div>
              <div className="bv-kv-item">
                <dt>Reviewed At</dt>
                <dd>{formatDateTime(application.reviewedAt)}</dd>
              </div>
            </dl>

            {application.status === 'REJECTED' ? (
              <div className="bv-alert bv-alert--error bv-mt-md" role="status">
                <div>
                  <strong>Rejection reason:</strong>{' '}
                  {application.reviewReason ?? 'No reason provided.'}
                </div>
                <p className="bv-muted bv-mt-xs">
                  Rejected applications require an explicit transition before changes are
                  accepted by the backend. Reopen as a draft or revise and resubmit
                  directly.
                </p>
                <div className="bv-actions-row bv-mt-sm">
                  <button
                    type="button"
                    className="bv-button bv-button--primary"
                    onClick={() => void handleReopenRejected()}
                    disabled={busyAction !== null}
                  >
                    {busyAction === 'reopen'
                      ? 'Reopening...'
                      : 'Reopen Application as Draft'}
                  </button>
                  <button
                    type="button"
                    className="bv-button bv-button--secondary"
                    onClick={() => setDirectResubmitMode((prev) => !prev)}
                    disabled={busyAction !== null}
                  >
                    {directResubmitMode
                      ? 'Cancel Direct Resubmission'
                      : 'Edit & Resubmit Directly'}
                  </button>
                </div>
              </div>
            ) : null}

            {isLockedPendingReview ? (
              <div className="bv-alert bv-alert--info bv-mt-md" role="status">
                Your application has been submitted and is awaiting administrator review.
                Profile editing is locked while review is in progress.
              </div>
            ) : null}

            {isApproved ? (
              <div className="bv-alert bv-alert--success bv-mt-md" role="status">
                <strong>Approved:</strong>{' '}
                {application.reviewReason ??
                  'Your synthetic onboarding application is verified.'}{' '}
                Approved applications are locked from further edits.
              </div>
            ) : null}
          </section>

          <section className="bv-card" aria-labelledby="onboarding-form-heading">
            <div className="bv-card-header">
              <div>
                <h2 id="onboarding-form-heading" className="bv-card-title">
                  Synthetic Profile Details
                </h2>
                <p className="bv-card-subtitle">
                  Use synthetic/non-real demonstration values only. Never submit real
                  government IDs or bank numbers.
                </p>
              </div>
            </div>

            <form
              className="bv-form"
              onSubmit={(e) => void handleSubmit(e)}
              noValidate
            >
              <ApiErrorAlert error={actionError} title="Onboarding update failed" />

              {fieldErrors.form ? (
                <div className="bv-alert bv-alert--error" role="alert">
                  {fieldErrors.form}
                </div>
              ) : null}

              {successMessage ? (
                <div className="bv-alert bv-alert--success" role="status">
                  {successMessage}
                </div>
              ) : null}

              <div className="bv-form-grid">
                <div className="bv-field">
                  <label htmlFor="ob-contact">Synthetic Contact Reference</label>
                  <input
                    id="ob-contact"
                    name="contactReference"
                    type="text"
                    placeholder="e.g. +91-90000-00001 or DEMO-REF-01"
                    value={form.contactReference}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        contactReference: e.target.value,
                      }))
                    }
                    disabled={!isEditable || busyAction !== null}
                    aria-invalid={Boolean(fieldErrors.contactReference)}
                  />
                  {fieldErrors.contactReference ? (
                    <p className="bv-field-error">{fieldErrors.contactReference}</p>
                  ) : null}
                </div>

                <div className="bv-field">
                  <label htmlFor="ob-city">City</label>
                  <input
                    id="ob-city"
                    name="city"
                    type="text"
                    placeholder="e.g. Bengaluru"
                    value={form.city}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, city: e.target.value }))
                    }
                    disabled={!isEditable || busyAction !== null}
                    aria-invalid={Boolean(fieldErrors.city)}
                  />
                  {fieldErrors.city ? (
                    <p className="bv-field-error">{fieldErrors.city}</p>
                  ) : null}
                </div>

                <div className="bv-field">
                  <label htmlFor="ob-country">Country</label>
                  <input
                    id="ob-country"
                    name="country"
                    type="text"
                    placeholder="e.g. India"
                    value={form.country}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, country: e.target.value }))
                    }
                    disabled={!isEditable || busyAction !== null}
                    aria-invalid={Boolean(fieldErrors.country)}
                  />
                  {fieldErrors.country ? (
                    <p className="bv-field-error">{fieldErrors.country}</p>
                  ) : null}
                </div>
              </div>

              <div className="bv-field">
                <label htmlFor="ob-purpose">Account Purpose</label>
                <textarea
                  id="ob-purpose"
                  name="accountPurpose"
                  rows={3}
                  placeholder="Describe the synthetic ledger demonstration purpose (min 10 characters)"
                  value={form.accountPurpose}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, accountPurpose: e.target.value }))
                  }
                  disabled={!isEditable || busyAction !== null}
                  aria-invalid={Boolean(fieldErrors.accountPurpose)}
                />
                {fieldErrors.accountPurpose ? (
                  <p className="bv-field-error">{fieldErrors.accountPurpose}</p>
                ) : null}
              </div>

              <div className="bv-checkbox-field">
                <input
                  id="ob-terms"
                  name="acceptedSyntheticTerms"
                  type="checkbox"
                  checked={form.acceptedSyntheticTerms}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      acceptedSyntheticTerms: e.target.checked,
                    }))
                  }
                  disabled={!isEditable || busyAction !== null}
                />
                <label htmlFor="ob-terms">
                  I acknowledge this is a synthetic demonstration environment with no real
                  money, bank rails, or KYC guarantees.
                </label>
              </div>
              {fieldErrors.acceptedSyntheticTerms ? (
                <p className="bv-field-error">{fieldErrors.acceptedSyntheticTerms}</p>
              ) : null}

              {isEditable ? (
                <div className="bv-actions-row">
                  {application.status !== 'REJECTED' ? (
                    <button
                      type="button"
                      className="bv-button bv-button--secondary"
                      onClick={() => void handleSaveDraft()}
                      disabled={busyAction !== null}
                    >
                      {busyAction === 'save' ? 'Saving Draft...' : 'Save Draft'}
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="bv-button bv-button--primary"
                    disabled={busyAction !== null}
                  >
                    {busyAction === 'submit'
                      ? 'Submitting...'
                      : application.status === 'REJECTED'
                        ? 'Resubmit Application'
                        : 'Submit for Review'}
                  </button>
                </div>
              ) : null}
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
