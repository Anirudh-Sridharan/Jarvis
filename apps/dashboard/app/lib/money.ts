/** Money display helpers — amounts are integer minor units (cents) everywhere. */

export function formatMinor(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** Major units for charts (minor/100). */
export function toMajor(amountMinor: number): number {
  return Math.round(amountMinor) / 100;
}
