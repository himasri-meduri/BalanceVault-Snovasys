import { parseRupeesInputToMinor } from './money';

export interface PasswordChecklist {
  minLength: boolean;
  maxLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
}

export function evaluatePasswordPolicy(password: string): PasswordChecklist {
  return {
    minLength: password.length >= 10,
    maxLength: password.length <= 128,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /[0-9]/.test(password),
    hasSpecial: /[^A-Za-z0-9]/.test(password),
  };
}

export function isPasswordPolicySatisfied(password: string): boolean {
  const c = evaluatePasswordPolicy(password);
  return (
    c.minLength &&
    c.maxLength &&
    c.hasUpper &&
    c.hasLower &&
    c.hasDigit &&
    c.hasSpecial
  );
}

const CONTACT_REFERENCE_REGEX = /^[+0-9A-Za-z -]+$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

export interface OnboardingFormValues {
  contactReference: string;
  city: string;
  country: string;
  accountPurpose: string;
  acceptedSyntheticTerms: boolean;
}

export function validateOnboardingFieldsForDraft(
  values: OnboardingFormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const contact = values.contactReference.trim();
  const city = values.city.trim();
  const country = values.country.trim();
  const purpose = values.accountPurpose.trim();

  if (contact.length > 0) {
    if (contact.length < 5 || contact.length > 40) {
      errors.contactReference = 'Contact reference must be 5 to 40 characters.';
    } else if (!CONTACT_REFERENCE_REGEX.test(contact)) {
      errors.contactReference =
        'Contact reference may contain only letters, digits, spaces, + and -.';
    }
  }

  if (city.length > 0 && (city.length < 2 || city.length > 80)) {
    errors.city = 'City must be 2 to 80 characters.';
  }

  if (country.length > 0 && (country.length < 2 || country.length > 60)) {
    errors.country = 'Country must be 2 to 60 characters.';
  }

  if (purpose.length > 0 && (purpose.length < 10 || purpose.length > 300)) {
    errors.accountPurpose = 'Account purpose must be 10 to 300 characters.';
  }

  return errors;
}

export function validateOnboardingFieldsForSubmit(
  values: OnboardingFormValues,
): Record<string, string> {
  const errors = validateOnboardingFieldsForDraft(values);

  if (values.contactReference.trim().length === 0) {
    errors.contactReference = 'Contact reference is required (5 to 40 characters).';
  }
  if (values.city.trim().length === 0) {
    errors.city = 'City is required (2 to 80 characters).';
  }
  if (values.country.trim().length === 0) {
    errors.country = 'Country is required (2 to 60 characters).';
  }
  if (values.accountPurpose.trim().length === 0) {
    errors.accountPurpose = 'Account purpose is required (10 to 300 characters).';
  }
  if (!values.acceptedSyntheticTerms) {
    errors.acceptedSyntheticTerms =
      'You must accept the synthetic demonstration terms before submitting.';
  }

  return errors;
}

export interface TransferFormValues {
  sourceAccountId: string;
  destinationAccountReference: string;
  amountRupees: string;
  description: string;
}

export function validateTransferForm(values: TransferFormValues): {
  errors: Record<string, string>;
  amountMinor: string | null;
} {
  const errors: Record<string, string> = {};

  if (!isValidUuid(values.sourceAccountId)) {
    errors.sourceAccountId = 'Select an active source synthetic account.';
  }

  const dest = values.destinationAccountReference.trim().toUpperCase();
  if (dest.length < 6 || dest.length > 40) {
    errors.destinationAccountReference =
      'Enter a destination account reference (e.g. BV-1A2B3C4D5E6F).';
  }

  const minor = parseRupeesInputToMinor(values.amountRupees, { allowZero: false });
  if (!minor) {
    errors.amountRupees =
      'Enter a positive INR amount with up to 2 decimal places (max ₹1,00,00,000.00).';
  }

  const desc = values.description.trim();
  if (desc.length < 3 || desc.length > 140) {
    errors.description = 'Description must be 3 to 140 characters.';
  }

  return { errors, amountMinor: minor };
}
