import { Currency } from './currency.js';

export interface RateQuote {
  base: Currency;
  quote: Currency;
  rate: number;
  fetchedAt: Date;
}

const cache: Record<string, RateQuote> = {};

export function saveQuote(quote: RateQuote): void {
  cache[quote.base + quote.quote] = quote;
}

export function getFreshQuote(
  base: Currency,
  quote: Currency,
  maxAgeSeconds = 30,
): RateQuote | undefined {
  const cached = cache[base + quote];
  if (!cached) {
    return undefined;
  }

  const age = (Date.now() - cached.fetchedAt.getTime()) / 1000;
  if (age > maxAgeSeconds) {
    return undefined;
  }
  return cached;
}

export function invertQuote(quote: RateQuote): RateQuote {
  quote.rate = 1 / quote.rate;
  [quote.base, quote.quote] = [quote.quote, quote.base];
  return quote;
}
