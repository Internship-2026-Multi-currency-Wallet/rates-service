import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { graphqlOptions } from './graphql.config.js';

const logger = { setContext: jest.fn(), debug: jest.fn() } as unknown as PinoLogger;

function websocketHooks(metrics: Metrics) {
  return graphqlOptions(AppConfig.fromEnv({}), logger, metrics).subscriptions?.[
    'graphql-ws'
  ] as unknown as {
    onConnect: (ctx: object) => void;
    onClose: (ctx: object) => void;
    onError: (
      ctx: object,
      id: string,
      payload: { query: string },
      errors: GraphQLError[],
    ) => unknown;
  };
}

describe('graphqlOptions websocket connections gauge', () => {
  const open = async (metrics: Metrics) =>
    (await metrics.graphqlWsConnections.get()).values[0]?.value ?? 0;

  it('decrements on close also for a socket that closed before the acknowledgement', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    const ws = websocketHooks(metrics);
    const socket = { extra: {} };
    ws.onConnect(socket);
    expect(await open(metrics)).toBe(1);
    ws.onClose(socket);
    expect(await open(metrics)).toBe(0);
  });

  it('never goes below zero for a socket that closed before onConnect', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    websocketHooks(metrics).onClose({ extra: {} });
    expect(await open(metrics)).toBe(0);
  });
});

describe('graphqlOptions websocket protocol errors', () => {
  it('counts a validation error as a client error and leaves the response as it is', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    const result = websocketHooks(metrics).onError({}, '1', { query: 'query Q { nope }' }, [
      new GraphQLError('Cannot query field "nope"'),
    ]);
    expect(result).toBeUndefined();
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="(unknown)",code="GRAPHQL_VALIDATION_FAILED"',
    );
  });

  it('counts a failure of a running subscription as a server error of its operation', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    const failure = new Error('Redis connection lost');
    websocketHooks(metrics).onError({}, '1', { query: 'subscription S { serverTime }' }, [
      new GraphQLError(failure.message, { originalError: failure }),
    ]);
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="subscription serverTime",code="INTERNAL_SERVER_ERROR"',
    );
  });
});
