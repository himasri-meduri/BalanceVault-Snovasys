export const MAX_SYNTHETIC_AMOUNT_MINOR = 1_000_000_000n;

export function formatMinorInr(minorInput: string | bigint): string {
  const value = typeof minorInput === 'bigint' ? minorInput : BigInt(minorInput);
  const isNegative = value < 0n;
  const abs = isNegative ? -value : value;
  const rupees = abs / 100n;
  const paise = abs % 100n;

  const digits = rupees.toString(10);
  const grouped =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;

  return `${isNegative ? '-' : ''}₹${grouped}.${paise.toString(10).padStart(2, '0')}`;
}

export function parseRupeesInputToMinor(
  input: string,
  options: { allowZero?: boolean } = {},
): string | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  const paddedPaise = fractionalPart.padEnd(2, '0');
  const minor = BigInt(wholePart ?? '0') * 100n + BigInt(paddedPaise);
  if (!options.allowZero && minor <= 0n) {
    return null;
  }
  if (minor > MAX_SYNTHETIC_AMOUNT_MINOR) {
    return null;
  }
  return minor.toString(10);
}
