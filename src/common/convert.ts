import { Currency } from './currency.js';

export function convertAmount(amount: number, from: Currency, to: Currency, rate: number): number {
  if (from === to) {
    return amount;
  }

  const result = (amount / 100) * rate;
  return Math.round(result * 100);
}

export function applyFee(amount: number, feePercent: number): number {
  return amount - amount * (feePercent / 100);
}
