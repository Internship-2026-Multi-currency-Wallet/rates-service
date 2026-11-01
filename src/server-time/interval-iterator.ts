/**
 * An AsyncIterableIterator that yields `produce()` every `periodMs` (first value immediately).
 * Stops cleanly when the subscriber goes away (`return()` clears the timer).
 */
export function intervalIterator<T>(periodMs: number, produce: () => T): AsyncIterableIterator<T> {
  const waiting: ((result: IteratorResult<T>) => void)[] = [];
  const buffered: T[] = [];
  let done = false;

  const push = (value: T) => {
    const resolve = waiting.shift();
    if (resolve) resolve({ value, done: false });
    else if (buffered.length < 10) buffered.push(value);
  };

  push(produce());
  const timer = setInterval(() => push(produce()), periodMs);

  const finish = (): Promise<IteratorResult<T>> => {
    done = true;
    clearInterval(timer);
    for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
    return Promise.resolve({ value: undefined, done: true });
  };

  return {
    next(): Promise<IteratorResult<T>> {
      if (done) return Promise.resolve({ value: undefined, done: true });
      const value = buffered.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return: finish,
    throw(error?: unknown): Promise<IteratorResult<T>> {
      void finish();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
