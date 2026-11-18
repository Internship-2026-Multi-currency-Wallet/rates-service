import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { createClient } from 'graphql-ws';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { MetricsServer } from '../src/metrics/metrics-server.js';
import { REDIS } from '../src/redis/redis.module.js';
import { createApp } from './create-app.js';
import { bearer } from './tokens.js';

const LIMITS = {
  THROTTLE_LIMIT_ANONYMOUS: '3',
  THROTTLE_LIMIT_USER: '5',
  THROTTLE_TTL_SECONDS: '2',
};
const ANONYMOUS_QUERY = '{ health { service } }';
const USER_QUERY = '{ me { id } }';

interface GqlBody {
  data: unknown;
  errors?: { extensions: Record<string, unknown> }[];
}

// Counters live in the real Redis and all specs call from 127.0.0.1, so each test sets its own X-Forwarded-For IP and user ids.
const randomIp = (): string => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const auth = (id: string, aud: 'wallet' | 'backoffice' = 'wallet') => ({
  Authorization: bearer({ sub: id, aud }),
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// The command client connects in the background; until it is ready the limiter lets requests through uncounted.
const redisReady = async (app: INestApplication): Promise<void> => {
  const redis = app.get<Redis>(REDIS);
  if (redis.status !== 'ready') await once(redis, 'ready', { signal: AbortSignal.timeout(10_000) });
};

const gqlOn = (app: INestApplication, query: string, headers: Record<string, string>) =>
  request(app.getHttpServer() as App)
    .post('/graphql')
    .set(headers)
    .send({ query });
const codeOf = (body: unknown): unknown => (body as GqlBody).errors?.[0]?.extensions.code;

describe('global rate limit (e2e)', () => {
  let app: INestApplication;

  const gql = (query: string, headers: Record<string, string>) => gqlOn(app, query, headers);
  const anonymous = (ip: string) => gql(ANONYMOUS_QUERY, { 'X-Forwarded-For': ip });
  const asUser = (ip: string, headers: Record<string, string>) =>
    gql(USER_QUERY, { 'X-Forwarded-For': ip, ...headers });
  const whoami = (headers: Record<string, string>) =>
    request(app.getHttpServer() as App)
      .get('/__test/whoami')
      .set({ 'X-Forwarded-For': randomIp(), ...headers });

  beforeAll(async () => {
    app = await createApp(LIMITS);
    await redisReady(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('counts anonymous requests per client IP', async () => {
    const ipA = randomIp();
    const ipB = randomIp();

    for (let i = 0; i < 3; i++) {
      expect(codeOf((await anonymous(ipA)).body)).toBeUndefined();
    }
    const refused = await anonymous(ipA);
    const other = await anonymous(ipB);

    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(other.body)).toBeUndefined();
  });

  it('counts the last X-Forwarded-For entry, so a spoofed first entry does not help', async () => {
    const proxyAddedIp = randomIp();

    for (let i = 0; i < 3; i++) {
      const res = await anonymous(`${randomIp()}, ${proxyAddedIp}`);
      expect(codeOf(res.body)).toBeUndefined();
    }
    const fourth = await anonymous(`${randomIp()}, ${proxyAddedIp}`);

    expect(codeOf(fourth.body)).toBe('TOO_MANY_REQUESTS');
  });

  it('counts authenticated requests per user with the user limit', async () => {
    const ip = randomIp();
    const user1 = auth(randomUUID());
    const user2 = auth(randomUUID());

    // 5 passes (not 3) prove the guard runs after AuthGuard and picks the user limit.
    for (let i = 0; i < 5; i++) {
      expect(codeOf((await asUser(ip, user1)).body)).toBeUndefined();
    }
    const refused = await asUser(ip, user1);
    const otherUser = await asUser(ip, user2);

    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(otherUser.body)).toBeUndefined();
  });

  it('keeps a user and a staff member with the same id in separate counters', async () => {
    const ip = randomIp();
    const id = randomUUID();

    for (let i = 0; i < 5; i++) {
      await asUser(ip, auth(id));
    }
    const userRefused = await asUser(ip, auth(id));
    const staff = await asUser(ip, auth(id, 'backoffice'));

    expect(codeOf(userRefused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(staff.body)).toBeUndefined();
  });

  it('answers a GraphQL refusal with the TOO_MANY_REQUESTS code and retryAfterSeconds', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await anonymous(ip);

    const refused = await anonymous(ip);

    const extensions = (refused.body as GqlBody).errors?.[0].extensions;
    expect(extensions).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: expect.any(Number),
    });
    expect([1, 2]).toContain(extensions?.retryAfterSeconds);
  });

  it('counts a GraphQL refusal in graphql_errors_total', async () => {
    const metricsUrl = `http://127.0.0.1:${app.get(MetricsServer).port}/metrics`;
    const refusals = async (): Promise<number> => {
      const line = (await (await fetch(metricsUrl)).text())
        .split('\n')
        .find(
          (l) => l.startsWith('graphql_errors_total{') && l.includes('code="TOO_MANY_REQUESTS"'),
        );
      return line ? Number(line.split(' ')[1]) : 0;
    };
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await anonymous(ip);
    const before = await refusals();

    await anonymous(ip);

    expect(await refusals()).toBe(before + 1);
  });

  it('answers a REST refusal with 429 and a Retry-After header', async () => {
    const headers = auth(randomUUID());
    for (let i = 0; i < 5; i++) await whoami(headers).expect(200);

    const refused = await whoami(headers).expect(429);

    expect([1, 2]).toContain(Number(refused.headers['retry-after']));
  });

  it('refuses until the window ends and not longer', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await anonymous(ip);
    const refused = await anonymous(ip);
    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    const retryAfterSeconds = (refused.body as GqlBody).errors?.[0].extensions
      .retryAfterSeconds as number;

    await sleep(retryAfterSeconds * 1000 + 100);

    expect(codeOf((await anonymous(ip)).body)).toBeUndefined();
  });

  it('never limits /health', async () => {
    const ip = randomIp();

    for (let i = 0; i < 10; i++) {
      for (const path of ['/health', '/health/']) {
        const res = await request(app.getHttpServer() as App)
          .get(path)
          .set('X-Forwarded-For', ip);
        expect(res.status).not.toBe(429);
      }
    }
  });

  it('counts one HTTP request once, however many top-level fields it has', async () => {
    const ip = randomIp();
    const twoFields = '{ a: health { service } b: health { service } }';

    for (let i = 0; i < 3; i++) {
      const res = await gql(twoFields, { 'X-Forwarded-For': ip });
      expect(codeOf(res.body)).toBeUndefined();
    }
    const fourth = await gql(twoFields, { 'X-Forwarded-For': ip });

    expect(codeOf(fourth.body)).toBe('TOO_MANY_REQUESTS');
  });
});

describe('GraphQL requests counted before Apollo (e2e)', () => {
  let app: INestApplication;

  const gql = (query: string, headers: Record<string, string>) => gqlOn(app, query, headers);

  beforeAll(async () => {
    app = await createApp(LIMITS);
    await redisReady(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function expectCounted(query: string): Promise<void> {
    const headers = { 'X-Forwarded-For': randomIp() };
    for (let i = 0; i < 3; i++) {
      expect(codeOf((await gql(query, headers)).body)).not.toBe('TOO_MANY_REQUESTS');
    }

    const refused = await gql(query, headers);

    expect(refused.status).toBe(200);
    expect((refused.body as GqlBody).errors?.[0].extensions).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: expect.any(Number),
    });
    expect([1, 2]).toContain(Number(refused.headers['retry-after']));
  }

  it.each([
    ['cannot be parsed', '{ health { service '],
    ['fails validation', '{ noSuchField }'],
    ['is an introspection query', '{ __schema { queryType { name } } }'],
    ['is refused by AuthGuard (401)', USER_QUERY],
  ])('counts a document that %s', async (_name, query) => {
    await expectCounted(query);
  });

  it('counts a request with an invalid token by IP, as anonymous', async () => {
    const headers = { 'X-Forwarded-For': randomIp(), Authorization: 'Bearer not-a-jwt' };

    for (let i = 0; i < 3; i++) await gql(ANONYMOUS_QUERY, headers);

    expect(codeOf((await gql(ANONYMOUS_QUERY, headers)).body)).toBe('TOO_MANY_REQUESTS');
  });

  it('sets the rate limit headers and counts several top-level fields once', async () => {
    const headers = { 'X-Forwarded-For': randomIp() };
    const twoFields = '{ health { service } again: health { service } }';

    const first = await gql(twoFields, headers);
    const second = await gql(twoFields, headers);

    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    expect(second.headers['x-ratelimit-remaining']).toBe('1');
    expect([1, 2]).toContain(Number(second.headers['x-ratelimit-reset']));
  });

  it('counts a logged-in user under the user key, not the IP', async () => {
    const ip = randomIp();

    const user = await gql(USER_QUERY, { 'X-Forwarded-For': ip, ...auth(randomUUID()) });
    const anonymous = await gql(ANONYMOUS_QUERY, { 'X-Forwarded-For': ip });

    expect(user.headers['x-ratelimit-limit']).toBe('5');
    expect(user.headers['x-ratelimit-remaining']).toBe('4');
    expect(anonymous.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('counts every path Apollo answers on (trailing slash, other case, query string)', async () => {
    const ip = randomIp();
    for (const path of ['/graphql/', '/GRAPHQL', '/graphql?x=1']) {
      const res = await request(app.getHttpServer() as App)
        .post(path)
        .set('X-Forwarded-For', ip)
        .send({ query: ANONYMOUS_QUERY });
      expect(codeOf(res.body)).toBeUndefined();
    }

    expect(codeOf((await gql(ANONYMOUS_QUERY, { 'X-Forwarded-For': ip })).body)).toBe(
      'TOO_MANY_REQUESTS',
    );
  });

  it('lets no more than the limit through when requests arrive at the same time', async () => {
    const ip = randomIp();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => gql(ANONYMOUS_QUERY, { 'X-Forwarded-For': ip })),
    );

    expect(responses.filter((res) => codeOf(res.body) !== 'TOO_MANY_REQUESTS')).toHaveLength(3);
  });

  it('does not count a CORS preflight', async () => {
    const res = await request(app.getHttpServer() as App)
      .options('/graphql')
      .set('X-Forwarded-For', randomIp());

    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('global rate limit and subscriptions (e2e)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await createApp(LIMITS);
    await redisReady(app);
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as { port: number };
    url = `ws://127.0.0.1:${address.port}/graphql`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not count or refuse websocket operations, even when the caller is over the limit', async () => {
    const headers = auth(randomUUID());
    const ip = randomIp();
    // The subscription authenticates as this same user, whose counter would be the one a counted websocket hits.
    for (let i = 0; i < 5; i++) await gqlOn(app, USER_QUERY, { 'X-Forwarded-For': ip, ...headers });
    const refused = await gqlOn(app, USER_QUERY, { 'X-Forwarded-For': ip, ...headers });
    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');

    const client = createClient({
      url,
      webSocketImpl: WebSocket,
      connectionParams: { Authorization: headers.Authorization },
      retryAttempts: 0,
    });
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const unsubscribe = client.subscribe<{ serverTime: string }>(
          { query: 'subscription { serverTime }' },
          {
            next: (result) => {
              unsubscribe();
              if (result.errors) reject(new Error(result.errors[0].message));
              else resolve(result.data!.serverTime);
            },
            error: (error) =>
              reject(error instanceof Error ? error : new Error(JSON.stringify(error))),
            complete: () => undefined,
          },
        );
      });
      expect(Number.isNaN(Date.parse(value))).toBe(false);
    } finally {
      await client.dispose();
    }
  });
});

describe('global rate limit when Redis is unavailable (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(LIMITS);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lets requests through instead of failing them', async () => {
    const ip = randomIp();
    app.get<Redis>(REDIS).disconnect();

    for (let i = 0; i < 5; i++) {
      const res = await gqlOn(app, ANONYMOUS_QUERY, { 'X-Forwarded-For': ip });
      expect((res.body as GqlBody).errors).toBeUndefined();
    }
  });
});
