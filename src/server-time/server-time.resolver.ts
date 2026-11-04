import { Subscription, Resolver } from '@nestjs/graphql';
import { intervalIterator } from './interval-iterator.js';

export const SERVER_TIME_PERIOD_MS = 1000;

/**
 * Example subscription proving GraphQL over websocket (graphql-ws) works end to end,
 * including auth via connection params. Live rates (`rateUpdated`) will follow the same pattern.
 */
@Resolver()
export class ServerTimeResolver {
  @Subscription(() => String, {
    description: 'Current server time (ISO 8601), emitted every second. Requires authentication.',
    resolve: (payload: { serverTime: string }) => payload.serverTime,
  })
  serverTime(): AsyncIterableIterator<{ serverTime: string }> {
    return intervalIterator(SERVER_TIME_PERIOD_MS, () => ({
      serverTime: new Date().toISOString(),
    }));
  }
}
