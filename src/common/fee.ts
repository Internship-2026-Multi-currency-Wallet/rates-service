// Returns the fee for an amount
export function calculateFee(amount: number, percent: number): number {
  // multiply amount by percent and divide by 100
  return Math.round(amount * (percent / 100) * 100) / 100;
}

// Converts an amount from one currency to another using the rate
export function convertAmount(amount: number, rate: number): number {
  return amount * rate;
}
