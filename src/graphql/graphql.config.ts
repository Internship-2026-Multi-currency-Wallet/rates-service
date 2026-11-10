import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type DocumentNode, type GraphQLError, parse } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { type RequestLike, requestFromConnectionParams } from '../auth/request-context.js';
import { graphqlLoggingPlugin, subscriptionLoggingHooks } from '../logging/graphql-logging.js';
import { type Metrics, UNKNOWN_OPERATION } from '../metrics/metrics.js';
import {
  countGraphqlErrors,
  graphqlMetricsPlugin,
  wsOperationName,
} from '../metrics/request-metrics.js';

/** Path of the committed GraphQL contract. Other repositories consume this file. */
export const SCHEMA_FILE = join(process.cwd(), 'schema.graphql');

interface ContextInput {
  req?: RequestLike;
  connectionParams?: Record<string, unknown>;
  extra?: { request?: unknown };
}

function parseQuery(query: string | undefined): DocumentNode | undefined {
  try {
    return query ? parse(query) : undefined;
  } catch {
    return undefined;
  }
}

function isServerError(error: GraphQLError): boolean {
  return Boolean(error.originalError ?? (error as { cause?: unknown }).cause);
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
    _ctx: unknown,
    _id: string,
    payload: { query?: string; operationName?: string | null },
    errors: readonly GraphQLError[],
  ): undefined => {
    if (!metrics) return undefined;
    if (errors.some((error) => !isServerError(error))) {
      metrics.graphqlErrors.inc({
        operation: UNKNOWN_OPERATION,
        code: 'GRAPHQL_VALIDATION_FAILED',
      });
    }
    countGraphqlErrors(
      metrics,
      wsOperationName(parseQuery(payload.query), payload.operationName),
      errors.filter(isServerError),
    );
    return undefined;
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
        onNext: (_ctx, _id, _payload, args, result) => {
          if (metrics) {
            countGraphqlErrors(
              metrics,
              wsOperationName(args.document, args.operationName),
              result.errors,
            );
          }
          return undefined;
        },
        ...{ onError: onProtocolError },
      },
    },
    // Names the operation in the access log and logs resolver errors with the requestId.
    plugins: [graphqlLoggingPlugin(), ...(metrics ? [graphqlMetricsPlugin(metrics)] : [])],
    // HTTP requests carry headers; websocket requests carry connectionParams.
    // Both end up as `context.req.headers`, which the auth guard reads.
    context: ({ req, connectionParams }: ContextInput) => ({
      req: req ?? requestFromConnectionParams(connectionParams),
    }),
  };
}
