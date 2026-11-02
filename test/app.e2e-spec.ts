import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from './create-app.js';
import { bearer, TEST_USER_ID } from './tokens.js';

const gql = (app: INestApplication, query: string, authorization?: string) => {
  const req = request(app.getHttpServer() as App).post('/graphql');
  if (authorization) req.set('Authorization', authorization);
  return req.send({ query });
};

describe('rates-service (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ CLIENT: 'demo' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports service, client and dependencies', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      appEnv: 'local',
      service: 'rates-service',
      client: 'demo',
      db: 'UP',
      redis: 'UP',
    });
  });

  it('query health is public', async () => {
    const res = await gql(app, '{ health { service version client db redis } }').expect(200);
    expect(res.body.data.health).toMatchObject({ service: 'rates-service', db: 'UP', redis: 'UP' });
  });

  it('query me returns the user from the access token', async () => {
    const res = await gql(app, '{ me { id permissions strategy } }', bearer()).expect(200);
    expect(res.body.data.me).toEqual({
      id: TEST_USER_ID,
      permissions: ['wallet'],
      strategy: 'jwt',
    });
  });

  it.each([
    ['without a token', undefined],
    ['with an expired token', bearer({ expiresIn: -60 })],
    [
      'with a token signed by someone else',
      bearer({ secret: 'not-the-real-secret-0123456789-abcdef' }),
    ],
    ['with the retired dev header', 'Dev 1:wallet'],
  ])('query me %s is UNAUTHENTICATED', async (_case, authorization) => {
    const res = await gql(app, '{ me { id } }', authorization);
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('HTTP endpoints answer 401 for a missing, invalid or expired token', async () => {
    const server = app.getHttpServer() as App;
    await request(server).get('/__test/whoami').expect(401);
    await request(server).get('/__test/whoami').set('Authorization', 'Bearer garbage').expect(401);
    await request(server)
      .get('/__test/whoami')
      .set('Authorization', bearer({ expiresIn: -60 }))
      .expect(401);
    const me = await request(server)
      .get('/__test/whoami')
      .set('Authorization', bearer({ permissions: ['bo:users'] }))
      .expect(200);
    expect(me.body).toEqual({ id: TEST_USER_ID, permissions: ['bo:users'], strategy: 'jwt' });
  });

  it('@RequirePermission returns 403 without the permission and 200 with it', async () => {
    const server = app.getHttpServer() as App;
    await request(server)
      .get('/__test/modify-users')
      .set('Authorization', bearer({ permissions: ['bo:users'] }))
      .expect(403);
    await request(server)
      .get('/__test/modify-users')
      .set('Authorization', bearer({ permissions: ['bo:users', 'bo:users:modify'] }))
      .expect(200, { ok: true });
  });
});
