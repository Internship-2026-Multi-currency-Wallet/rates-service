import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException } from '@nestjs/common';
import type {
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLError,
  GraphQLFormattedError,
} from 'graphql';
import { isExpectedGraphqlError } from './expected-error.filter.js';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Apollo `formatError`: hides unexpected errors from the client. The original error is found with
 * `unwrapResolverError`, never from the formatted code, which `@nestjs/apollo` and Apollo may
 * already have changed. Errors thrown on purpose (a `GraphQLError` with a code, or a Nest
 * `HttpException`) pass as formatted; anything else (a Redis error, a bug) becomes a bare
 * `INTERNAL_SERVER_ERROR`, because its message can carry internals. A `GraphQLError` without a
 * code is unexpected too: GraphQL itself throws one when a resolver returns a wrong value, with
 * that value in the message. Over HTTP the original is still logged by `graphqlLoggingPlugin`,
 * which runs first.
 */
export function formatError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  return formatOriginal(formatted, unwrapResolverError(error));
}

/**
 * The masking of `formatError` for an error already known to be the one thrown, which is not
 * unwrapped again: a thrown GraphQLError can itself carry a path and an `originalError`.
 */
function formatOriginal(
  formatted: GraphQLFormattedError,
  original: unknown,
): GraphQLFormattedError {
  if (original instanceof HttpException || isExpectedGraphqlError(original)) return formatted;
  return {
    message: INTERNAL_ERROR_MESSAGE,
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}

/**
 * graphql-ws `onNext`: the same `formatError` for results sent over the websocket (any operation
 * can go there, not only subscriptions), which Apollo's `formatError` does not see. Returning
 * nothing sends the result unchanged.
 */
export function formatExecutionResult(
  result: ExecutionResult,
): FormattedExecutionResult | undefined {
  if (!result.errors) return undefined;
  return { ...result, errors: result.errors.map((error) => formatError(error.toJSON(), error)) };
}

/**
 * What a running subscription threw, from the graphql-ws `onError` error: graphql-ws wraps it in a
 * pathless GraphQLError (`originalError`, or `cause` with graphql 17) that copies its `extensions`,
 * so the wrapper's code says nothing about it and `unwrapResolverError` (path only) keeps the
 * wrapper. `undefined`: the client's validation error.
 */
export function serverProtocolOriginal(error: GraphQLError): unknown {
  return error.originalError ?? (error as { cause?: unknown }).cause ?? undefined;
}

/**
 * graphql-ws `onError` bypasses Apollo's formatError, so server failures are masked here, using the
 * error the server threw. The client's validation errors are sent as graphql-ws formats them.
 */
export function formatProtocolErrors(
  errors: readonly GraphQLError[],
): { error: GraphQLFormattedError; fromClient: boolean }[] {
  return errors.map((error) => {
    const thrown = serverProtocolOriginal(error);
    return thrown !== undefined
      ? { error: formatOriginal(error.toJSON(), thrown), fromClient: false }
      : { error: error.toJSON(), fromClient: true };
  });
}
