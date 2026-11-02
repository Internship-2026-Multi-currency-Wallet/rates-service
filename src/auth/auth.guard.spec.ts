import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { AuthStrategy } from './auth-strategy.js';
import { AuthGuard } from './auth.guard.js';
import { JwtAuthStrategy } from './jwt-auth.strategy.js';
import { Public } from './public.decorator.js';
import type { RequestLike } from './request-context.js';

class TestController {
  @Public()
  open(): void {}

  closed(): void {}
}

type Transport = 'http' | 'graphql';

function context(
  handler: keyof TestController,
  request: RequestLike,
  transport: Transport = 'http',
): ExecutionContext {
  const args = transport === 'graphql' ? [undefined, {}, { req: request }, undefined] : [request];
  const host = new ExecutionContextHost(args, TestController, TestController.prototype[handler]);
  host.setType(transport);
  return host;
}

const SECRET = 'unit-test-secret-0123456789-abcdefghij';
const USER_ID = '6f1c2b8e-3d4a-4e5f-8a9b-0c1d2e3f4a5b';

describe('AuthGuard', () => {
  const reflector = new Reflector();
  const jwtService = new JwtService();
  const jwt = new JwtAuthStrategy(
    jwtService,
    AppConfig.fromEnv({ JWT_SECRET: SECRET }),
    new PinoLogger({ pinoHttp: { level: 'silent' } }),
  );
  const guard = new AuthGuard(reflector, [jwt]);

  const token = (expiresIn = 900): string =>
    jwtService.sign(
      { sub: USER_ID, permissions: ['wallet'] },
      { secret: SECRET, algorithm: 'HS256', issuer: 'wallet-core', expiresIn },
    );
  const bearer = (value: string): RequestLike => ({
    headers: { authorization: `Bearer ${value}` },
  });

  describe.each<Transport>(['http', 'graphql'])('over %s', (transport) => {
    it('authenticates an access token and stores the user on the request', async () => {
      const request = bearer(token());
      await expect(guard.canActivate(context('closed', request, transport))).resolves.toBe(true);
      expect(request.user).toEqual({ id: USER_ID, permissions: ['wallet'], strategy: 'jwt' });
    });

    it('rejects requests without a token', async () => {
      await expect(
        guard.canActivate(context('closed', { headers: {} }, transport)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects invalid and expired tokens', async () => {
      await expect(
        guard.canActivate(context('closed', bearer('garbage'), transport)),
      ).rejects.toThrow('Invalid access token');
      await expect(
        guard.canActivate(context('closed', bearer(token(-60)), transport)),
      ).rejects.toThrow('Access token expired');
    });
  });

  it('rejects the retired dev header', async () => {
    const request = { headers: { authorization: 'Dev 1:wallet' } };
    await expect(guard.canActivate(context('closed', request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('lets anonymous callers reach @Public() handlers', async () => {
    await expect(guard.canActivate(context('open', { headers: {} }))).resolves.toBe(true);
  });

  it('treats a bad token on a @Public() handler as anonymous', async () => {
    const request = bearer('garbage');
    await expect(guard.canActivate(context('open', request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('still identifies the user on @Public() handlers', async () => {
    const request = bearer(token());
    await guard.canActivate(context('open', request));
    expect(request.user?.id).toBe(USER_ID);
  });

  it('tries strategies in order; the first one that returns a user wins', async () => {
    const other: AuthStrategy = {
      name: 'other',
      authenticate: ({ authorization }) =>
        authorization === 'Other x' ? { id: 'o1', permissions: [], strategy: 'other' } : null,
    };
    const chained = new AuthGuard(reflector, [jwt, other]);

    const jwtRequest = bearer(token());
    await chained.canActivate(context('closed', jwtRequest));
    expect(jwtRequest.user?.strategy).toBe('jwt');

    const otherRequest: RequestLike = { headers: { authorization: 'Other x' } };
    await chained.canActivate(context('closed', otherRequest));
    expect(otherRequest.user?.strategy).toBe('other');
  });
});
