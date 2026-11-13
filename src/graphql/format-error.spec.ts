import { describe, expect, it } from '@jest/globals';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GraphQLError, buildSchema, graphqlSync } from 'graphql';
import { formatError, formatExecutionResult, formatProtocolErrors } from './format-error.js';

const MASKED = { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };

/** What graphql-js does with an error thrown in a resolver: wraps it with the path. */
function thrownInResolver(error: Error): GraphQLError {
  return new GraphQLError(error.message, { path: ['rate'], originalError: error });
}

describe('formatError', () => {
  it('hides the message of an unexpected error', () => {
    const error = thrownInResolver(new Error('connect ECONNREFUSED 10.0.0.7:6379'));
    const formatted = {
      ...error.toJSON(),
      extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at ...'] },
    };
    expect(formatError(formatted, error)).toEqual({ ...MASKED, path: ['rate'] });
  });

  it('keeps a GraphQLError thrown on purpose', () => {
    const error = thrownInResolver(
      new GraphQLError('Too many requests', { extensions: { code: 'TOO_MANY_REQUESTS' } }),
    );
    const formatted = error.toJSON();
    expect(formatError(formatted, error)).toBe(formatted);
  });

  it('hides a plain Error even when its wrapper inherited a code from it', () => {
    const tagged = Object.assign(new Error('private detail'), {
      extensions: { code: 'TOO_MANY_REQUESTS' },
    });
    const error = thrownInResolver(tagged);
    expect(error.extensions.code).toBe('TOO_MANY_REQUESTS');
    expect(formatError(error.toJSON(), error)).toEqual({ ...MASKED, path: ['rate'] });
  });

  it.each([
    ['401', new UnauthorizedException(), 'UNAUTHENTICATED'],
    ['404', new NotFoundException('Nope'), 'INTERNAL_SERVER_ERROR'],
  ])('leaves a %s HttpException as Nest formatted it', (_status, exc, code) => {
    const formatted = { message: exc.message, extensions: { code } };
    expect(formatError(formatted, thrownInResolver(exc))).toBe(formatted);
  });

  it('hides a plain Error that only carries a 4xx status, e.g. from a downstream HTTP client', () => {
    const downstream = Object.assign(new Error('Request failed with status code 401'), {
      status: 401,
    });
    const error = thrownInResolver(downstream);
    expect(formatError(error.toJSON(), error)).toEqual({ ...MASKED, path: ['rate'] });
    expect(
      formatProtocolErrors([new GraphQLError(downstream.message, { originalError: downstream })]),
    ).toEqual([{ error: MASKED, fromClient: false }]);
  });

  it('keeps errors raised by GraphQL itself (parse, validation)', () => {
    const error = new GraphQLError('Cannot query field "nope" on type "Query".', {
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });
    const formatted = error.toJSON();
    expect(formatError(formatted, error)).toBe(formatted);
  });

  it('hides a GraphQLError without a code, e.g. a value GraphQL could not serialize', () => {
    const schema = buildSchema('type Query { rate: String }');
    const leaked = { apiKey: 'source-api-key' };
    const [error] =
      graphqlSync({ schema, source: '{ rate }', rootValue: { rate: () => leaked } }).errors ?? [];
    expect(error.message).toContain('source-api-key');
    expect(formatError(error.toJSON(), error)).toEqual({
      ...MASKED,
      locations: error.locations,
      path: ['rate'],
    });
  });
});

describe('formatExecutionResult', () => {
  it('sends a result without errors unchanged', () => {
    expect(formatExecutionResult({ data: { rate: '1' } })).toBeUndefined();
  });

  it('masks unexpected errors and keeps the data and expected errors', () => {
    const expected = thrownInResolver(
      new GraphQLError('Too many requests', { extensions: { code: 'TOO_MANY_REQUESTS' } }),
    );
    const unexpected = thrownInResolver(new Error('private detail'));
    expect(formatExecutionResult({ data: null, errors: [expected, unexpected] })).toEqual({
      data: null,
      errors: [expected.toJSON(), { ...MASKED, path: ['rate'] }],
    });
  });

  it('sends a pathless variable error as it is, keeps extensions and leaves the result unchanged', () => {
    const variable = new GraphQLError(
      'Variable "$flag" of required type "Boolean!" was not provided.',
    );
    const unexpected = thrownInResolver(new Error('private detail'));
    const result = { errors: [variable, unexpected], extensions: { cost: 1 } };
    const snapshot = JSON.stringify(result.errors);

    expect(formatExecutionResult(result)).toEqual({
      errors: [variable.toJSON(), { ...MASKED, path: ['rate'] }],
      extensions: { cost: 1 },
    });
    expect(result.errors[0]).toBe(variable);
    expect(JSON.stringify(result.errors)).toBe(snapshot);
  });
});

describe('formatProtocolErrors', () => {
  it('leaves a client validation error as graphql-ws formats it', () => {
    const error = new GraphQLError('Cannot query field "nope"');
    expect(formatProtocolErrors([error])).toEqual([{ error: error.toJSON(), fromClient: true }]);
  });

  it('classifies a stream failure by the error the server threw, not by the wrapper', () => {
    const tagged = Object.assign(new Error('private detail'), {
      extensions: { code: 'BUSINESS_REFUSAL' },
    });
    const wrapper = new GraphQLError(tagged.message, { originalError: tagged });
    expect(wrapper.extensions.code).toBe('BUSINESS_REFUSAL');
    expect(formatProtocolErrors([wrapper])).toEqual([{ error: MASKED, fromClient: false }]);
  });

  it('keeps a thrown coded GraphQLError that has its own path and cause, without unwrapping it', () => {
    const coded = new GraphQLError('Business refused', {
      path: ['upstream'],
      originalError: new Error('private cause'),
      extensions: { code: 'BUSINESS_REFUSAL' },
    });
    const wrapper = new GraphQLError(coded.message, { originalError: coded });
    const [item] = formatProtocolErrors([wrapper]);
    expect(item).toEqual({
      error: { message: 'Business refused', extensions: { code: 'BUSINESS_REFUSAL' } },
      fromClient: false,
    });
    expect(JSON.stringify(item)).not.toContain('private cause');
  });

  it('keeps a stream failure thrown as a coded GraphQLError', () => {
    const coded = new GraphQLError('Business refused', {
      extensions: { code: 'BUSINESS_REFUSAL' },
    });
    const wrapper = new GraphQLError(coded.message, { originalError: coded });
    expect(formatProtocolErrors([wrapper])).toEqual([
      {
        error: { message: 'Business refused', extensions: { code: 'BUSINESS_REFUSAL' } },
        fromClient: false,
      },
    ]);
  });
});
