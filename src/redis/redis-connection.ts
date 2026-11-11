import type { Redis, RedisOptions } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';

/** Upper bound for one Redis command issued while serving a request (health, publish, ...). */
export const REDIS_COMMAND_TIMEOUT_MS = 2000;

/**
 * Shared command client: serves HTTP requests, so it fails fast. `commandTimeout` bounds every
 * command even while the client is reconnecting (offline queue); `maxRetriesPerRequest` drops
 * queued commands after a few failed reconnects. Reconnects use the ioredis default backoff
 * (exponential, capped at 5 s, with jitter) and never give up.
 *
 * `lazyConnect`: the app can start (and generate its schema) without Redis running.
 */
export const COMMAND_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
};

/**
 * Dedicated pub/sub client (see `EventSubscriber`). Nobody waits on it during a request, so
 * SUBSCRIBE/UNSUBSCRIBE stay queued until Redis is reachable instead of failing:
 * `maxRetriesPerRequest: null` (never flush the offline queue) and no `commandTimeout`.
 * Once a SUBSCRIBE succeeded, ioredis (`autoResubscribe`) restores it after every reconnect.
 * Same default reconnect backoff as the command client.
 */
export const SUBSCRIBER_CLIENT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  commandTimeout: undefined,
  autoResubscribe: true,
};

/**
 * A reason that is safe to log: the error code (`ECONNREFUSED`), the Redis error word
 * (`NOAUTH`, `WRONGPASS`) or the error class. Never the message (it may contain hosts).
 */
export function redisErrorReason(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
    if (name === 'ReplyError' && typeof message === 'string') {
      const word = message.split(' ', 1)[0];
      if (/^[A-Z]+$/.test(word)) return word;
    }
    if (typeof name === 'string' && /^\w+$/.test(name)) return name;
  }
  return 'unknown';
}

/**
 * Turns ioredis connection errors into one warning per outage (then `debug` while it stays
 * down) and an `info` when the connection is ready again. Without an `error` listener ioredis
 * prints every failed reconnect to stderr.
 */
export function watchRedisConnection(
  redis: Redis,
  logger: PinoLogger,
  connection: 'command' | 'subscriber',
): void {
  let down = false;
  redis.on('error', (error: unknown) => {
    const reason = redisErrorReason(error);
    if (down) {
      logger.debug({ connection, reason }, 'Redis still unavailable');
      return;
    }
    down = true;
    logger.warn({ connection, reason }, 'Redis unavailable, reconnecting with backoff');
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    logger.info({ connection }, 'Redis connection restored');
  });
}

/** Closes a client without waiting on an unreachable Redis: QUIT only when ready, bounded. */
export async function closeRedis(redis: Redis, timeoutMs = 1000): Promise<void> {
  if (redis.status !== 'ready') {
    redis.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch {
    redis.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
