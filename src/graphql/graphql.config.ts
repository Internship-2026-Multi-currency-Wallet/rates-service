import { join } from 'node:path';
import { unwrapResolverError } from '@apollo/server/errors';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import type { Response } from 'express';
import {
  type DocumentNode,
  execute,
  type GraphQLError,
  type GraphQLFormattedError,
  parse,
  subscribe,
} from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { type RequestLike, requestFromConnectionParams } from '../auth/request-context.js';
import {
  graphqlLoggingPlugin,
  inWsLoggingContext,
  logWsErrors,
  subscriptionLoggingHooks,
  type WsContext,
  type WsSubscribePayload,
  wsRequestId,
} from '../logging/graphql-logging.js';
import { type Metrics, UNKNOWN_OPERATION } from '../metrics/metrics.js';
import {
  countGraphqlErrors,
  graphqlMetricsPlugin,
  wsOperationName,
} from '../metrics/request-metrics.js';
import {
  formatError,
  formatExecutionResult,
  formatProtocolErrors,
  serverProtocolOriginal,
} from './format-error.js';

/** Path of the committed GraphQL contract. Other repositories consume this file. */
export const SCHEMA_FILE = join(process.cwd(), 'schema.graphql');

interface ContextInput {
  req?: RequestLike;
  res?: Response;
  connectionParams?: Record<string, unknown>;
  extra?: { request?: unknown };
}

export interface GraphqlContext {
  req: RequestLike;
  /** Absent over websocket. */
  res?: Response;
  /** Websocket only: the connection's requestId, bound to the operation's logs. */
  requestId?: string;
}

function parseQuery(query: string | undefined): DocumentNode | undefined {
  try {
    return query ? parse(query) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apollo, code-first. Outside production the schema is written to `schema.graphql`
 * (sorted, so diffs are stable) — commit it together with resolver changes.
 */
export function graphqlOptions(
  config: AppConfig,
  logger: PinoLogger,
  metrics?: Metrics,
): ApolloDriverConfig {
  logger.setContext('GraphQL');
  const wsLogging = subscriptionLoggingHooks(logger);
  const countedSockets = new WeakSet<object>();
  const onProtocolError = (
    ctx: WsContext,
    id: string,
    payload: WsSubscribePayload,
    errors: readonly GraphQLError[],
  ): GraphQLFormattedError[] | undefined => {
    logWsErrors(logger, ctx, { id, payload }, errors, serverProtocolOriginal);
    const formatted = formatProtocolErrors(errors);
    const fromServer = formatted.filter((item) => !item.fromClient).map((item) => item.error);
    if (metrics) {
      if (formatted.some((item) => item.fromClient)) {
        metrics.graphqlErrors.inc({
          labels: { operation: UNKNOWN_OPERATION, code: 'GRAPHQL_VALIDATION_FAILED' },
        });
      }
      countGraphqlErrors(
        metrics,
        wsOperationName(parseQuery(payload.query), payload.operationName),
        fromServer,
      );
    }
    // Only client validation errors: graphql-ws sends them unchanged.
    return fromServer.length ? formatted.map((item) => item.error) : undefined;
  };
  return {
    driver: ApolloDriver,
    autoSchemaFile: config.isProduction ? true : SCHEMA_FILE,
    sortSchema: true,
    path: '/graphql',
    introspection: true,
    // GraphQL subscriptions over websocket (graphql-ws protocol) on the same path.
    // Subscription start/end are logged with the connection's requestId.
    subscriptions: {
      'graphql-ws': {
        path: '/graphql',
        ...wsLogging,
        onConnect: (ctx) => {
          wsLogging.onConnect(ctx);
          if (metrics && !countedSockets.has(ctx)) {
            countedSockets.add(ctx);
            metrics.graphqlWsConnections.inc();
          }
        },
        onClose: (ctx) => {
          if (countedSockets.delete(ctx)) metrics?.graphqlWsConnections.dec();
        },
        // Apollo's formatError does not see websocket results: mask them the same way.
        onNext: (ctx, id, payload, args, result) => {
          // Execution errors carry a path; pathless ones are the client's variable errors.
          logWsErrors(logger, ctx, { id, payload }, result.errors, (error) =>
            error.path !== undefined ? unwrapResolverError(error) : undefined,
          );
          const formatted = formatExecutionResult(result);
          if (metrics) {
            countGraphqlErrors(
              metrics,
              wsOperationName(args.document, args.operationName),
              (formatted ?? result).errors,
            );
          }
          return formatted;
        },
        // Nest's config type omits these but passes every option on to graphql-ws, so this works;
        // the spread keeps the type check from rejecting it.
        ...{
          onError: onProtocolError,
          execute: inWsLoggingContext(logger, execute),
          subscribe: inWsLoggingContext(logger, subscribe),
        },
      },
    },
    // Names the operation in the access log and logs resolver errors with the requestId.
    plugins: [graphqlLoggingPlugin(), ...(metrics ? [graphqlMetricsPlugin(metrics)] : [])],
    // Unexpected errors reach the client as a bare INTERNAL_SERVER_ERROR (no internals).
    formatError,
    // graphql-ws supplies connectionParams and extra rather than an HTTP req.
    context: ({ req, res, connectionParams, extra }: ContextInput): GraphqlContext =>
      req
        ? { req, res }
        : {
            req: requestFromConnectionParams(connectionParams),
            requestId: wsRequestId({ connectionParams, extra }),
          },
  };
}
