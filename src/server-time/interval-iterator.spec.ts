import { jest } from '@jest/globals';
import { intervalIterator } from './interval-iterator.js';

describe('intervalIterator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('yields immediately and then every period', async () => {
    let n = 0;
    const it = intervalIterator(1000, () => ++n);
    await expect(it.next()).resolves.toEqual({ value: 1, done: false });

    const second = it.next();
    jest.advanceTimersByTime(1000);
    await expect(second).resolves.toEqual({ value: 2, done: false });
    await it.return!();
  });

  it('stops producing after return()', async () => {
    let n = 0;
    const it = intervalIterator(1000, () => ++n);
    await it.next();
    await it.return!();
    jest.advanceTimersByTime(5000);
    expect(n).toBe(1);
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
