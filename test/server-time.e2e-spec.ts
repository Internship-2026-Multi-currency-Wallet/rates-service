import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { type Client, createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { createApp } from './create-app.js';

function wsClient(url: string, connectionParams?: Record<string, string>): Client {
  return createClient({ url, webSocketImpl: WebSocket, connectionParams, retryAttempts: 0 });
}

/** Collects `count` values of a subscription, or rejects with the first error. */
function take(client: Client, query: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const values: string[] = [];
    const unsubscribe = client.subscribe<{ serverTime: string }>(
      { query },
      {
        next: (result) => {
          if (result.errors) {
            unsubscribe();
            reject(new Error(result.errors[0].message));
            return;
          }
          values.push(result.data!.serverTime);
          if (values.length === count) {
            unsubscribe();
            resolve(values);
          }
        },
        error: (error) => reject(error instanceof Error ? error : new Error(JSON.stringify(error))),
        complete: () => undefined,
      },
    );
  });
}

describe('serverTime subscription (e2e, graphql-ws)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true' });
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as { port: number };
    url = `ws://127.0.0.1:${address.port}/graphql`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams the server time every second with dev auth in connection params', async () => {
    const client = wsClient(url, { Authorization: 'Dev 1:wallet' });
    try {
      const values = await take(client, 'subscription { serverTime }', 2);
      expect(values).toHaveLength(2);
      const [first, second] = values.map((value) => Date.parse(value));
      expect(second - first).toBeGreaterThanOrEqual(900);
    } finally {
      await client.dispose();
    }
  });

  it('rejects the subscription without credentials', async () => {
    const client = wsClient(url);
    try {
      await expect(take(client, 'subscription { serverTime }', 1)).rejects.toThrow(
        /Authentication required|Unauthorized/,
      );
    } finally {
      await client.dispose();
    }
  });
});
