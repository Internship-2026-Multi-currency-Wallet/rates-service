import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { getLoggerToken, type PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DiagnosticsModule } from '../src/diagnostics/diagnostics.module.js';
import { EventPublisher } from '../src/events/event-bus.js';
import { createApp } from './create-app.js';
import { RedisProxy } from './redis-proxy.js';
import { bearer } from './tokens.js';

/**
 * Redis outages against real MySQL and real Redis. The app talks to Redis through a local TCP
 * proxy that the test stops and starts on the same port; the shared Redis is never stopped or
 * flushed. Delivery is observed through the "system.ping received" log of DiagnosticsModule.
 */
describe('Redis outage (e2e, real Redis behind a controllable proxy)', () => {
  const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const run = `e2e-outage-${process.pid}-${Date.now()}`;
  let proxy: RedisProxy;
  let app: INestApplication;
  let direct: Redis;
  let publisher: EventPublisher;
  let received: { mock: { calls: unknown[][] } };
  let consoleError: jest.Spied<typeof console.error>;
  let seq = 0;

  const server = () => app.getHttpServer() as App;
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const start = Date.now();
    const result = await fn();
    return [result, Date.now() - start];
  };
  const deliveries = (from: string) =>
    received.mock.calls.filter(
      ([fields]) => (fields as { from?: string } | undefined)?.from === from,
    ).length;

  /** Publishes system.ping (directly to the shared Redis) until the app's handler logs one. */
  async function waitForDelivery(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const from = `${run}-probe-${++seq}`;
      await publisher.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (deliveries(from) > 0) return;
    }
    throw new Error('system.ping was not delivered after Redis came back');
  }

  /** One ping must be handled exactly once (no duplicated handlers after reconnects). */
  async function expectExactlyOnce(): Promise<void> {
    const from = `${run}-once-${++seq}`;
    await publisher.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(deliveries(from)).toBe(1);
  }

  async function waitForHealth(redis: 'UP' | 'DOWN', timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(server()).get('/health');
      if (res.body.redis === redis) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`health never reported redis=${redis}`);
  }

  beforeAll(async () => {
    consoleError = jest.spyOn(console, 'error');
    proxy = await RedisProxy.reserve(sharedRedisUrl); // reserved, NOT listening: Redis is "down"
    direct = new Redis(sharedRedisUrl);
    publisher = new EventPublisher(direct, 'local');
  });

  afterAll(async () => {
    await app?.close();
    await proxy.stop();
    await direct.quit();
    consoleError.mockRestore();
    // `disconnect()` on a client whose Redis is unreachable leaves the ioredis safety timer
    // (`disconnectTimeout`, 2 s) running; let it expire so Jest exits cleanly.
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });

  it('starts and listens while Redis is unreachable', async () => {
    const [created, ms] = await timed(() => createApp({ APP_ENV: 'local', REDIS_URL: proxy.url }));
    app = created;
    expect(ms).toBeLessThan(10_000);
    await app.listen(0, '127.0.0.1');
    received = jest.spyOn(app.get<PinoLogger>(getLoggerToken(DiagnosticsModule.name)), 'info');
  });

  it('GET /health answers 200 degraded (db UP, redis DOWN) within a bounded time', async () => {
    const [res, ms] = await timed(() => request(server()).get('/health'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'UP', redis: 'DOWN' });
    expect(ms).toBeLessThan(3000);
  });

  it('POST /diagnostics/ping answers 503 within a bounded time', async () => {
    const [res, ms] = await timed(() =>
      request(server()).post('/diagnostics/ping').set('Authorization', bearer()),
    );
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(3000);
  });

  it('delivers system.ping once Redis appears at the same endpoint (cold start)', async () => {
    await proxy.start();
    await waitForHealth('UP');
    await waitForDelivery();
    await expectExactlyOnce();
    const res = await request(server()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'UP', redis: 'UP' });
    await request(server())
      .post('/diagnostics/ping')
      .set('Authorization', bearer())
      .expect(200, { published: true });
  });

  it('resumes delivery after losing a working Redis, without duplicated handlers', async () => {
    await proxy.stop();
    await waitForHealth('DOWN');
    const [res, ms] = await timed(() => request(server()).get('/health'));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(3000);

    await proxy.start();
    await waitForHealth('UP');
    await waitForDelivery();
    await expectExactlyOnce();

    // A second outage: still exactly one handler.
    await proxy.stop();
    await waitForHealth('DOWN');
    await proxy.start();
    await waitForDelivery();
    await expectExactlyOnce();
  });

  it('shuts down within a bounded time while Redis is unreachable', async () => {
    await proxy.stop();
    await waitForHealth('DOWN');
    const [, ms] = await timed(() => app.close());
    expect(ms).toBeLessThan(5000);
    app = undefined as unknown as INestApplication;
  });

  it('never let ioredis print unhandled error events', () => {
    const ioredisErrors = consoleError.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes('[ioredis]'),
    );
    expect(ioredisErrors).toEqual([]);
  });
});
