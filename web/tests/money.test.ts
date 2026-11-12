import { describe, expect, it } from 'vitest';
import { formatMinorInr, parseRupeesInputToMinor } from '../src/lib/money';
import { validateTransferForm } from '../src/lib/validation';

describe('frontend money formatting, bounds, and transfer validation', () => {
  it('formats positive and negative minor unit strings to INR without floating point inaccuracies', () => {
    expect(formatMinorInr('0')).toBe('₹0.00');
    expect(formatMinorInr('12500')).toBe('₹125.00');
    expect(formatMinorInr('2500000')).toBe('₹25,000.00');
    expect(formatMinorInr('-500000')).toBe('-₹5,000.00');
  });

  it('parses decimal rupee strings into exact integer paise strings and enforces bounds', () => {
    expect(parseRupeesInputToMinor('125')).toBe('12500');
    expect(parseRupeesInputToMinor('125.5')).toBe('12550');
    expect(parseRupeesInputToMinor('0.01')).toBe('1');
    expect(parseRupeesInputToMinor('0')).toBeNull();
    expect(parseRupeesInputToMinor('0', { allowZero: true })).toBe('0');
    expect(parseRupeesInputToMinor('10000000.00')).toBe('1000000000');
    expect(parseRupeesInputToMinor('10000000.01')).toBeNull();
    expect(parseRupeesInputToMinor('-5')).toBeNull();
    expect(parseRupeesInputToMinor('12.345')).toBeNull();
  });

  it('validates internal simulated transfer form inputs strictly', () => {
    const invalid = validateTransferForm({
      sourceAccountId: 'not-a-uuid',
      destinationAccountReference: 'BV',
      amountRupees: '0',
      description: 'Hi',
    });
    expect(Object.keys(invalid.errors)).toEqual(
      expect.arrayContaining([
        'sourceAccountId',
        'destinationAccountReference',
        'amountRupees',
        'description',
      ]),
    );
    expect(invalid.amountMinor).toBeNull();

    const valid = validateTransferForm({
      sourceAccountId: '11111111-1111-4111-8111-111111111111',
      destinationAccountReference: 'BV-9988776655AA',
      amountRupees: '1500.25',
      description: 'Synthetic demo vault settlement',
    });
    expect(valid.errors).toEqual({});
    expect(valid.amountMinor).toBe('150025');
  });
});
