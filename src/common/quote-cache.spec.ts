import { QUOTE_MAX_AGE_MS, QuoteCache, type RateQuote } from './quote-cache.js';

const quote = (overrides: Partial<RateQuote> = {}): RateQuote => ({
  base: 'USD',
  quote: 'UAH',
  rate: '41.2534',
  fetchedAt: 1_000_000,
  ...overrides,
});

describe('QuoteCache', () => {
  it('serves a quote until it is older than the max age', () => {
    let now = 1_000_000;
    const cache = new QuoteCache(() => now);
    cache.save(quote());

    now += QUOTE_MAX_AGE_MS;
    expect(cache.getFresh('USD', 'UAH')?.rate).toBe('41.2534');

    now += 1;
    expect(cache.getFresh('USD', 'UAH')).toBeUndefined();
  });

  it('measures age across minute boundaries', () => {
    let now = 50_000;
    const cache = new QuoteCache(() => now);
    cache.save(quote({ fetchedAt: 50_000 }));

    now = 100_000;
    expect(cache.getFresh('USD', 'UAH')).toBeUndefined();
  });

  it('does not serve quotes from the future', () => {
    const cache = new QuoteCache(() => 1_000_000);
    cache.save(quote({ fetchedAt: 1_000_001 }));
    expect(cache.getFresh('USD', 'UAH')).toBeUndefined();
  });

  it('returns a copy, so callers cannot change the cached quote', () => {
    const cache = new QuoteCache(() => 1_000_000);
    cache.save(quote());

    const served = cache.getFresh('USD', 'UAH');
    if (served) served.rate = '0.1';

    expect(cache.getFresh('USD', 'UAH')?.rate).toBe('41.2534');
  });

  it('keeps currency pairs apart', () => {
    const cache = new QuoteCache(() => 1_000_000);
    cache.save(quote());
    expect(cache.getFresh('UAH', 'USD')).toBeUndefined();
  });

  it.each(['0', '0.000', '-1', '1e3', 'abc', '', '1.'])('rejects the rate %p', (rate) => {
    const cache = new QuoteCache(() => 1_000_000);
    expect(() => cache.save(quote({ rate }))).toThrow('Invalid rate');
  });

  it('rejects a non-finite fetchedAt', () => {
    const cache = new QuoteCache(() => 1_000_000);
    expect(() => cache.save(quote({ fetchedAt: Number.NaN }))).toThrow('Invalid fetchedAt');
  });
});
