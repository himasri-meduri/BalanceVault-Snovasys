import { describe, expect, it } from 'vitest';
import {
  formatMinorUnitsInr,
  parseMinorUnits,
  serializeMinorUnits,
} from '../src/shared/money.js';
import {
  generateAccountReference,
  generateTransactionReference,
} from '../src/shared/reference.js';

describe('money minor-unit utilities', () => {
  it('parses valid integer minor units strictly using BigInt', () => {
    expect(parseMinorUnits('12500')).toBe(12500n);
    expect(parseMinorUnits('1')).toBe(1n);
    expect(serializeMinorUnits(12500n)).toBe('12500');
  });

  it('formats INR amounts accurately without floating point arithmetic', () => {
    expect(formatMinorUnitsInr(0n)).toBe('₹0.00');
    expect(formatMinorUnitsInr(12500n)).toBe('₹125.00');
    expect(formatMinorUnitsInr(123456789n)).toBe('₹12,34,567.89');
    expect(formatMinorUnitsInr(-505n)).toBe('-₹5.05');
  });

  it('rejects decimals, negative strings, zero (when positive required), and oversized values', () => {
    expect(() => parseMinorUnits('12.50')).toThrow();
    expect(() => parseMinorUnits('-100')).toThrow();
    expect(() => parseMinorUnits('0')).toThrow();
    expect(parseMinorUnits('0', { requirePositive: false })).toBe(0n);
    expect(() => parseMinorUnits('99999999999999999')).toThrow();
  });
});

describe('non-sequential reference generators', () => {
  it('generates distinct non-sequential public references', () => {
    const a1 = generateAccountReference();
    const a2 = generateAccountReference();
    const t1 = generateTransactionReference();

    expect(a1).toMatch(/^BV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(t1).toMatch(/^TXN-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(a1).not.toBe(a2);
  });
});
