import { Currency } from './currency.js';

export interface RateQuote {
  base: Currency;
  quote: Currency;
  /** Decimal string, e.g. "41.2534". */
  rate: string;
  /** Epoch milliseconds. */
  fetchedAt: number;
}

export const QUOTE_MAX_AGE_MS = 30_000;

const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d+(\.\d+)?$/;

export class QuoteCache {
  private readonly quotes = new Map<string, RateQuote>();

  constructor(private readonly now: () => number = Date.now) {}

  save(quote: RateQuote): void {
    if (!POSITIVE_DECIMAL.test(quote.rate)) {
      throw new Error(`Invalid rate "${quote.rate}" for ${quote.base}/${quote.quote}`);
    }
    if (!Number.isFinite(quote.fetchedAt)) {
      throw new Error(`Invalid fetchedAt for ${quote.base}/${quote.quote}`);
    }
    this.quotes.set(QuoteCache.key(quote.base, quote.quote), { ...quote });
  }

  getFresh(base: Currency, quote: Currency): RateQuote | undefined {
    const cached = this.quotes.get(QuoteCache.key(base, quote));
    if (!cached) {
      return undefined;
    }
    const age = this.now() - cached.fetchedAt;
    if (age < 0 || age > QUOTE_MAX_AGE_MS) {
      return undefined;
    }
    return { ...cached };
  }

  private static key(base: Currency, quote: Currency): string {
    return `${base}/${quote}`;
  }
}
