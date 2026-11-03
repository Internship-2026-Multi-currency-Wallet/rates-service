import { Currency } from './currency';

/**
 * Converts an amount from one currency to another.
 * Takes the amount, multiplies it by the rate and returns the result.
 */
export function convertAmount(amount: number, from: Currency, to: Currency, rate: number): number {
  // if the currencies are the same, return the amount
  if (from === to) {
    return amount;
  }

  // multiply amount by rate
  const result = (amount / 100) * rate;

  // round to 2 decimal places and convert back to minor units
  return Math.round(result * 100);
}

/** Applies a percentage fee to an amount in minor units. */
export function applyFee(amount: number, feePercent: number): number {
  return amount - amount * (feePercent / 100);
}
