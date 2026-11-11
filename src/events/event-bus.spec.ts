import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { RateTickEvent } from './catalog.js';
import {
  decodePubSubMessage,
  decodeStreamEntry,
  decodeStreamMeta,
  eventChannel,
  type EventContext,
  EventPublisher,
  eventStream,
  EventSubscriber,
  redisName,
} from './event-bus.js';

const tick: RateTickEvent = {
  v: 1,
  source: 'fake',
  base: 'USD',
  quote: 'UAH',
  bid: null,
  ask: null,
  mid: '41.5000',
  ts: '2026-01-01T00:00:00.000Z',
};

describe('EventPublisher', () => {
  it('publishes pub/sub events to their channel', async () => {
    const redis = { publish: jest.fn(() => Promise.resolve(1)), xadd: jest.fn() };
    const publisher = new EventPublisher(redis as unknown as Redis, 'kvitka-uat');

    await expect(publisher.publish('rate.tick', tick)).resolves.toBeNull();
    expect(redis.publish).toHaveBeenCalledWith('kvitka-uat:rate.tick', expect.any(String));
    const [, message] = redis.publish.mock.calls[0] as unknown as [string, string];
    expect(decodePubSubMessage(message)).toEqual({
      meta: { publishedAt: expect.any(String) },
      payload: tick,
    });
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('adds the meta of the current context (requestId) to every event', async () => {
    const redis = { publish: jest.fn(() => Promise.resolve(1)), xadd: jest.fn() };
    const context: EventContext = {
      current: () => ({ requestId: 'req-1', publisher: 'wallet-core' }),
      run: (_meta, fn) => fn(),
    };
    await new EventPublisher(redis as unknown as Redis, 'staging', context).publish(
      'rate.tick',
      tick,
    );
    const [, message] = redis.publish.mock.calls[0] as unknown as [string, string];
    expect(decodePubSubMessage(message).meta).toMatchObject({
      requestId: 'req-1',
      publisher: 'wallet-core',
    });
  });

  it('reports a published event with its payload, and not one that failed', async () => {
    const onPublished = jest.fn();
    const ok = { publish: jest.fn(() => Promise.resolve(1)), xadd: jest.fn() };
    await new EventPublisher(ok as unknown as Redis, 'staging', undefined, onPublished).publish(
      'rate.tick',
      tick,
    );
    expect(onPublished).toHaveBeenCalledWith('rate.tick', tick);

    const down = { publish: jest.fn(() => Promise.reject(new Error('down'))), xadd: jest.fn() };
    await expect(
      new EventPublisher(down as unknown as Redis, 'staging', undefined, onPublished).publish(
        'rate.tick',
        tick,
      ),
    ).rejects.toThrow('down');
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('appends stream events with XADD and a capped length', async () => {
    const redis = { publish: jest.fn(), xadd: jest.fn(() => Promise.resolve('1-0')) };
    const publisher = new EventPublisher(redis as unknown as Redis, 'kvitka-uat');
    const event = {
      v: 1 as const,
      eventId: 'e1',
      conversionId: 'c1',
      client: 'demo',
      userId: 'u1',
      from: { currency: 'USD' as const, amount: '10000' },
      to: { currency: 'UAH' as const, amount: '415000' },
      rate: '41.5',
      midRate: '41.6',
      occurredAt: '2026-01-01T00:00:00.000Z',
    };

    await expect(publisher.publish('conversion.completed', event)).resolves.toBe('1-0');
    expect(redis.xadd).toHaveBeenCalledWith(
      'kvitka-uat:conversion.completed',
      'MAXLEN',
      '~',
      '100000',
      '*',
      'payload',
      JSON.stringify(event),
      'meta',
      expect.any(String),
    );
    const fields = (redis.xadd.mock.calls[0] as unknown as string[]).slice(5);
    expect(decodeStreamEntry('conversion.completed', fields)).toEqual(event);
    expect(decodeStreamMeta(fields)).toEqual({ publishedAt: expect.any(String) });
    expect(decodeStreamMeta(['payload', '{}'])).toEqual({});
  });
});

describe('EventSubscriber', () => {
  function fakeConnection() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      status: 'ready',
      subscribe: jest.fn(() => Promise.resolve(1)),
      unsubscribe: jest.fn(() => Promise.resolve(0)),
      quit: jest.fn(() => Promise.resolve('OK')),
      disconnect: jest.fn(),
    });
  }

  it('delivers parsed payloads to handlers and unsubscribes', async () => {
    const connection = fakeConnection();
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    const received: RateTickEvent[] = [];

    const off = await subscriber.subscribe('rate.tick', (payload) => {
      received.push(payload);
    });
    expect(connection.subscribe).toHaveBeenCalledWith('staging:rate.tick');

    const message = JSON.stringify({ meta: {}, payload: tick });
    connection.emit('message', 'staging:rate.tick', message);
    connection.emit('message', 'rate.tick', message); // no prefix: another environment
    connection.emit('message', 'local:rate.tick', message);
    connection.emit('message', 'staging:rate.tick', JSON.stringify(tick)); // bare payload, no meta
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([tick, tick]);

    await off();
    expect(connection.unsubscribe).toHaveBeenCalledWith('staging:rate.tick');
  });

  it('runs handlers inside the context of the incoming meta', async () => {
    const connection = fakeConnection();
    const runs: string[] = [];
    const context: EventContext = {
      current: () => ({}),
      run: (meta, fn) => {
        runs.push(meta.requestId ?? '-');
        return fn();
      },
    };
    const subscriber = new EventSubscriber(
      connection as unknown as Redis,
      'staging',
      undefined,
      context,
    );
    const metas: unknown[] = [];
    await subscriber.subscribe('rate.tick', (_payload, meta) => {
      metas.push(meta);
    });

    connection.emit(
      'message',
      'staging:rate.tick',
      JSON.stringify({ meta: { requestId: 'req-42' }, payload: tick }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toEqual(['req-42']);
    expect(metas).toEqual([{ requestId: 'req-42' }]);
  });

  it('reports each received message once, decodable or not, whatever the number of handlers', async () => {
    const connection = fakeConnection();
    const onReceived = jest.fn();
    const subscriber = new EventSubscriber(
      connection as unknown as Redis,
      'staging',
      undefined,
      undefined,
      onReceived,
    );
    await subscriber.subscribe('rate.tick', () => undefined);
    await subscriber.subscribe('rate.tick', () => undefined);

    connection.emit('message', 'staging:rate.tick', JSON.stringify(tick));
    connection.emit('message', 'staging:rate.tick', 'not json');
    connection.emit('message', 'local:rate.tick', JSON.stringify(tick));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onReceived).toHaveBeenCalledTimes(2);
    expect(onReceived).toHaveBeenNthCalledWith(1, 'rate.tick');
    expect(onReceived).toHaveBeenNthCalledWith(2, 'rate.tick');
  });

  it('reports bad messages and failing handlers to onError', async () => {
    const connection = fakeConnection();
    const onError = jest.fn();
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging', onError);
    await subscriber.subscribe('rate.tick', () => {
      throw new Error('boom');
    });

    connection.emit('message', 'staging:rate.tick', 'not json');
    connection.emit('message', 'staging:rate.tick', JSON.stringify(tick));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(1, expect.any(Error), 'staging:rate.tick', 'rate.tick');
    expect(onError).toHaveBeenNthCalledWith(2, expect.any(Error), 'staging:rate.tick', 'rate.tick');
  });
});

describe('EventSubscriber while Redis is unavailable', () => {
  function fakeConnection(status = 'reconnecting') {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      status,
      subscribe: jest.fn<(channel: string) => Promise<unknown>>(() => Promise.resolve(1)),
      unsubscribe: jest.fn<(channel: string) => Promise<unknown>>(() => Promise.resolve(0)),
      quit: jest.fn(() => Promise.resolve('OK')),
      disconnect: jest.fn(),
    });
  }

  it('rolls back a failed SUBSCRIBE so a later subscribe sends it again', async () => {
    const connection = fakeConnection();
    connection.subscribe.mockRejectedValueOnce(new Error('Connection is closed.'));
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    const first = jest.fn<() => void>();

    await expect(subscriber.subscribe('system.ping', first)).rejects.toThrow(
      'Connection is closed.',
    );
    const second = jest.fn<() => void>();
    await subscriber.subscribe('system.ping', second);
    expect(connection.subscribe).toHaveBeenCalledTimes(2);

    connection.emit('message', 'staging:system.ping', JSON.stringify({ v: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps event-name callbacks in step with failed, retried and removed subscriptions', async () => {
    const connection = fakeConnection('ready');
    connection.subscribe.mockRejectedValueOnce(new Error('Connection is closed.'));
    const onError = jest.fn();
    const onReceived = jest.fn();
    const subscriber = new EventSubscriber(
      connection as unknown as Redis,
      'staging',
      onError,
      undefined,
      onReceived,
    );
    const ping = () => connection.emit('message', 'staging:system.ping', 'not json');
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    await expect(subscriber.subscribe('system.ping', () => undefined)).rejects.toThrow();
    ping(); // the failed subscription left nothing behind
    await flush();
    expect(onReceived).not.toHaveBeenCalled();

    const stale = await subscriber.subscribe('system.ping', () => undefined);
    await stale();
    const off = await subscriber.subscribe('system.ping', () => undefined);
    await stale(); // a late cleanup of the earlier subscription must not remove the newer one
    ping();
    await flush();
    expect(onReceived).toHaveBeenCalledTimes(1);
    expect(onReceived).toHaveBeenCalledWith('system.ping');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'staging:system.ping', 'system.ping');

    await off();
    ping();
    await flush();
    expect(onReceived).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('shares one pending SUBSCRIBE between concurrent callers', async () => {
    const connection = fakeConnection();
    let confirm!: (value: unknown) => void;
    connection.subscribe.mockReturnValueOnce(new Promise((resolve) => (confirm = resolve)));
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    const settled: string[] = [];

    const a = subscriber.subscribe('rate.tick', () => undefined).then(() => settled.push('a'));
    const b = subscriber.subscribe('rate.tick', () => undefined).then(() => settled.push('b'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toEqual([]); // nobody is told "subscribed" before Redis confirms
    confirm(1);
    await Promise.all([a, b]);
    expect(settled).toEqual(['a', 'b']);
    expect(connection.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not wait for UNSUBSCRIBE while disconnected', async () => {
    const connection = fakeConnection('ready');
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    const off = await subscriber.subscribe('rate.tick', () => undefined);
    connection.status = 'reconnecting';
    connection.unsubscribe.mockReturnValueOnce(new Promise(() => undefined)); // never answers

    await expect(off()).resolves.toBeUndefined();
    expect(connection.unsubscribe).toHaveBeenCalledWith('staging:rate.tick');
    await off(); // idempotent
    expect(connection.unsubscribe).toHaveBeenCalledTimes(1);

    await subscriber.close();
    expect(connection.disconnect).toHaveBeenCalled();
    expect(connection.quit).not.toHaveBeenCalled();
  });
});

describe('EventSubscriber.close', () => {
  afterEach(() => jest.useRealTimers());

  it('completes when the connection was ready but QUIT never settles', async () => {
    jest.useFakeTimers();
    const connection = Object.assign(new EventEmitter(), {
      status: 'ready',
      subscribe: jest.fn(() => Promise.resolve(1)),
      quit: jest.fn(() => new Promise(() => undefined)), // Redis dropped during QUIT
      disconnect: jest.fn(),
    });
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    await subscriber.subscribe('rate.tick', () => undefined);

    let closed = false;
    const closing = subscriber.close().then(() => (closed = true));
    await jest.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    expect(connection.disconnect).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); // closeRedis deadline (1 s)
    await closing;
    expect(connection.quit).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('Redis names', () => {
  it('prefixes channels and streams with the environment', () => {
    expect(redisName('wisla-uat', 'x')).toBe('wisla-uat:x');
    expect(eventChannel('staging', 'rate.tick')).toBe('staging:rate.tick');
    expect(eventStream('kvitka-uat', 'conversion.completed')).toBe(
      'kvitka-uat:conversion.completed',
    );
  });

  it('rejects an empty or nested prefix', () => {
    expect(() => redisName('', 'rate.tick')).toThrow(/prefix/);
    expect(() => redisName('a:b', 'rate.tick')).toThrow(/prefix/);
  });
});
