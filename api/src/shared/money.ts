import { ValidationError } from './errors.js';

/**
 * Maximum bounded synthetic transfer amount: INR 1,00,00,000.00 (10,000,000.00 INR = 1,000,000,000 paise)
 */
export const MAX_SYNTHETIC_AMOUNT_MINOR = 1_000_000_000n;

const INTEGER_MINOR_REGEX = /^\d+$/;

export function parseMinorUnits(
  raw: string | bigint,
  options: { requirePositive?: boolean; maxMinor?: bigint } = {},
): bigint {
  const { requirePositive = true, maxMinor = MAX_SYNTHETIC_AMOUNT_MINOR } = options;

  let value: bigint;
  if (typeof raw === 'bigint') {
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!INTEGER_MINOR_REGEX.test(trimmed)) {
      throw new ValidationError('Amount must be a non-negative integer minor-unit string', {
        amountMinor: ['Must contain digits only (integer minor units, e.g., "12500")'],
      });
    }
    value = BigInt(trimmed);
  } else {
    throw new ValidationError('Amount must be an integer minor-unit string');
  }

  if (requirePositive && value <= 0n) {
    throw new ValidationError('Amount must be greater than zero', {
      amountMinor: ['Amount must be a positive integer in minor units'],
    });
  }

  if (value > maxMinor) {
    throw new ValidationError('Amount exceeds synthetic demonstration limit', {
      amountMinor: [`Amount must not exceed ${maxMinor.toString()} minor units`],
    });
  }

  return value;
}

export function serializeMinorUnits(amountMinor: bigint): string {
  return amountMinor.toString(10);
}

export function formatMinorUnitsInr(amountMinor: bigint): string {
  const isNegative = amountMinor < 0n;
  const abs = isNegative ? -amountMinor : amountMinor;
  const rupees = abs / 100n;
  const paise = abs % 100n;

  const formattedRupees = formatIndianGrouping(rupees.toString(10));
  const formattedPaise = paise.toString(10).padStart(2, '0');
  return `${isNegative ? '-' : ''}₹${formattedRupees}.${formattedPaise}`;
}

function formatIndianGrouping(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3);
  const groupedLeading = leading.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${groupedLeading},${lastThree}`;
}
