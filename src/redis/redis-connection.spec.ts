import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import {
  closeRedis,
  COMMAND_CLIENT_OPTIONS,
  redisErrorReason,
  REDIS_COMMAND_TIMEOUT_MS,
  SUBSCRIBER_CLIENT_OPTIONS,
  watchRedisConnection,
} from './redis-connection.js';
import { createRedis, createSubscriberRedis } from './redis.module.js';

function fakeLogger() {
  return { warn: jest.fn(), debug: jest.fn(), info: jest.fn() };
}

describe('Redis client options', () => {
  it('command client fails fast; subscriber client keeps commands queued', () => {
    const redis = createRedis('redis://127.0.0.1:1');
    const subscriber = createSubscriberRedis(redis);
    try {
      expect(redis.options).toMatchObject({
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
        enableOfflineQueue: true,
      });
      expect(subscriber.options.maxRetriesPerRequest).toBeNull();
      expect(subscriber.options.commandTimeout).toBeUndefined();
      expect(subscriber.options.autoResubscribe).toBe(true);
      expect(subscriber.options.lazyConnect).toBe(true);
      // Both reconnect forever with the ioredis exponential backoff.
      for (const client of [redis, subscriber]) {
        const strategy = client.options.retryStrategy!;
        const first = strategy(1) as number;
        const late = strategy(30) as number;
        expect(first).toBeLessThan(300);
        expect(late).toBeGreaterThanOrEqual(5000);
        expect(late).toBeLessThan(5300);
      }
    } finally {
      redis.disconnect();
      subscriber.disconnect();
    }
    expect(COMMAND_CLIENT_OPTIONS).not.toBe(SUBSCRIBER_CLIENT_OPTIONS);
  });
});

describe('redisErrorReason', () => {
  it('returns a safe code, never the message', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), {
      code: 'ECONNREFUSED',
    });
    expect(redisErrorReason(refused)).toBe('ECONNREFUSED');
    const reply = Object.assign(new Error('WRONGPASS invalid username-password pair'), {
      name: 'ReplyError',
    });
    expect(redisErrorReason(reply)).toBe('WRONGPASS');
    const retries = Object.assign(new Error('Reached the max retries per request limit'), {
      name: 'MaxRetriesPerRequestError',
    });
    expect(redisErrorReason(retries)).toBe('MaxRetriesPerRequestError');
    expect(redisErrorReason('redis://user:secret@host')).toBe('unknown');
  });
});

describe('watchRedisConnection', () => {
  it('warns once per outage with a safe reason and reports recovery', () => {
    const redis = new EventEmitter();
    const logger = fakeLogger();
    watchRedisConnection(redis as unknown as Redis, logger as unknown as PinoLogger, 'subscriber');
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:16379'), {
      code: 'ECONNREFUSED',
    });

    redis.emit('ready'); // first connect: nothing to report
    redis.emit('error', error);
    redis.emit('error', error);
    redis.emit('error', error);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { connection: 'subscriber', reason: 'ECONNREFUSED' },
      expect.any(String),
    );
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('127.0.0.1');

    redis.emit('ready');
    expect(logger.info).toHaveBeenCalledWith({ connection: 'subscriber' }, expect.any(String));
    redis.emit('error', error);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('closeRedis', () => {
  it('disconnects without QUIT when not ready', async () => {
    const redis = { status: 'reconnecting', quit: jest.fn(), disconnect: jest.fn() };
    await closeRedis(redis as unknown as Redis);
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('falls back to disconnect when QUIT does not answer in time', async () => {
    const redis = {
      status: 'ready',
      quit: jest.fn(() => new Promise(() => undefined)),
      disconnect: jest.fn(),
    };
    await closeRedis(redis as unknown as Redis, 10);
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('quits gracefully when ready', async () => {
    const redis = {
      status: 'ready',
      quit: jest.fn(() => Promise.resolve('OK')),
      disconnect: jest.fn(),
    };
    await closeRedis(redis as unknown as Redis);
    expect(redis.quit).toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });
});
