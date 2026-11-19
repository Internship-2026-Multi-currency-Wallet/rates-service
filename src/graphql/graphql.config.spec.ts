import { beforeEach, jest } from '@jest/globals';
import type { Response } from 'express';
import { type DocumentNode, type ExecutionResult, GraphQLError, parse } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { type GraphqlContext, graphqlOptions } from './graphql.config.js';

const logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('graphqlOptions context', () => {
  const context = graphqlOptions(AppConfig.fromEnv({}), logger as unknown as PinoLogger)
    .context as (input: Record<string, unknown>) => GraphqlContext;

  it('passes the HTTP request and response to resolvers', () => {
    const req = { headers: { authorization: 'Bearer token' } };
    const res = {} as Response;
    expect(context({ req, res })).toEqual({ req, res });
  });

  it('builds the request from websocket connection params, with the connection requestId', () => {
    const connectionParams = { Authorization: 'Bearer token', 'X-Request-Id': 'ws-1' };
    expect(context({ connectionParams, extra: {} })).toEqual({
      req: { headers: { authorization: 'Bearer token', 'x-request-id': 'ws-1' } },
      requestId: 'ws-1',
    });
  });
});

function websocketHooks(metrics: Metrics) {
  return graphqlOptions(AppConfig.fromEnv({}), logger as unknown as PinoLogger, metrics)
    .subscriptions?.['graphql-ws'] as unknown as {
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts a validation error as a client error and leaves the response as it is', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    const result = websocketHooks(metrics).onError(
      { extra: {} },
      '1',
      { query: 'query Q { nope }' },
      [new GraphQLError('Cannot query field "nope"')],
    );
    expect(result).toBeUndefined();
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="(unknown)",code="GRAPHQL_VALIDATION_FAILED"',
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('masks a failure of a running subscription, logs it and counts it as a server error', async () => {
    const metrics = new Metrics({ service: 'rates-service', env: 'local' });
    const failure = new Error('Redis connection lost to redis://internal-host:6379');
    const result = websocketHooks(metrics).onError(
      { extra: {} },
      '1',
      { query: 'subscription S { serverTime }' },
      [new GraphQLError(failure.message, { originalError: failure })],
    );
    expect(result).toEqual([
      { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ]);
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="subscription serverTime",code="INTERNAL_SERVER_ERROR"',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR', err: failure }),
      `GraphQL error: ${failure.message}`,
    );
  });

  it('masks a subscription failure wrapped the graphql 17 way (cause, no originalError)', () => {
    const failure = new Error('Redis connection lost to redis://internal-host:6379');
    const wrapped = Object.assign(new GraphQLError(failure.message), { cause: failure });
    const result = websocketHooks(new Metrics({ service: 'rates-service', env: 'local' })).onError(
      { extra: {} },
      '1',
      { query: 'subscription S { serverTime }' },
      [wrapped],
    );
    expect(result).toEqual([
      { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ]);
    expect(JSON.stringify(result)).not.toContain('internal-host');
  });
});

describe('graphqlOptions websocket results', () => {
  type OnNext = (
    ctx: object,
    id: string,
    payload: { query: string },
    args: { document: DocumentNode; operationName?: string },
    result: ExecutionResult,
  ) => unknown;

  const SERVICE = 'rates-service';
  const query = 'subscription Ticks { ticks }';
  const crashed = (): ExecutionResult => {
    const failure = new Error('Duplicate entry for redis://internal-host:6379');
    return {
      data: { ticks: null },
      errors: [new GraphQLError(failure.message, { path: ['ticks'], originalError: failure })],
    };
  };
  const quietLogger = () => ({
    setContext: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });

  function send(log: object, metrics: Metrics, result: ExecutionResult): unknown {
    const options = graphqlOptions(AppConfig.fromEnv({}), log as unknown as PinoLogger, metrics);
    const { onNext } = options.subscriptions?.['graphql-ws'] as unknown as { onNext: OnNext };
    return onNext({ extra: {} }, '1', { query }, { document: parse(query) }, result);
  }

  const errorCount = async (metrics: Metrics) =>
    (await metrics.graphqlErrors.get()).values.find(
      (v) =>
        v.labels.operation === 'subscription ticks' && v.labels.code === 'INTERNAL_SERVER_ERROR',
    )?.value ?? 0;

  it('masks and counts as before when logging fails, without throwing', async () => {
    const metrics = new Metrics({ service: SERVICE, env: 'local' });
    const failingLogger = {
      ...quietLogger(),
      error: jest.fn(() => {
        throw new Error('log stream closed');
      }),
    };
    const sent = send(failingLogger, metrics, crashed());
    expect(failingLogger.error).toHaveBeenCalledTimes(1);
    expect(sent).toEqual({
      data: { ticks: null },
      errors: [
        {
          message: 'Internal server error',
          path: ['ticks'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
    });
    expect(await errorCount(metrics)).toBe(1);
  });

  it('logs and masks without changing the result it was given', () => {
    const log = quietLogger();
    const result = crashed();
    const [error] = result.errors ?? [];
    const before = { message: error.message, extensions: { ...error.extensions } };
    send(log, new Metrics({ service: SERVICE, env: 'local' }), result);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([error]);
    expect({ message: error.message, extensions: error.extensions }).toEqual(before);
  });
});
