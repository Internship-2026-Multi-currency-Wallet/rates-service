# rates-service

The exchange-rate service of the white-label multi-currency wallet: adapters for public rate sources
(polling and WebSocket), aggregation into a consensus rate (staleness, outliers, triangulation), and the
live rate stream (`rate.tick` on Redis, GraphQL subscriptions for the frontends).

Today this repository is a **skeleton**: a NestJS + GraphQL service with health checks, an example GraphQL
subscription and the _seams_ (auth, permissions, settings, events) that let you build features before
the real parts exist. The features themselves are your tasks.

## Stack

NestJS 12 · GraphQL (Apollo Server 5, code-first) · Knex + MySQL 8 · Redis (ioredis) · Jest · ESLint + Prettier ·
Node.js 26 (ES modules, TypeScript 6).

## Run locally

Prerequisites: Node.js 26 (`nvm use`), Docker, and the `ops` repository cloned next to this one (`../ops`).
MySQL and Redis come from `ops`; `npm run infra` calls `../ops/dev.sh` from here:

```sh
npm run infra:up              # MySQL (all databases) + Redis only — no application services
npm install
cp .env.example .env          # optional: the defaults match the ops stack
npm run migrate
npm run start:dev
```

Without a `.env` the service still starts: every variable has a local default. That includes `JWT_SECRET`, which
falls back to the **local-only learning secret** `local-only-jwt-secret-change-me-0123456789` (the same value as in
`.env.example`). wallet-core must sign tokens with the same secret, or every request is 401. The fallback applies only
when `NODE_ENV` is not `production`; in production `JWT_SECRET` is required and the service refuses to start without it.

- GraphQL: <http://localhost:3001/graphql> (Apollo Sandbox in the browser)
- Health: <http://localhost:3001/health>

Need another service as well? Run it in Docker next to yours, e.g. `npm run infra -- up wallet-core`
(several names allowed, `all` = the whole system). Containers reach this service at
`http://host.docker.internal:3001`; it reaches them at `localhost:<port>`. Do not start this service in Docker
while you run it from source (same port).

| Script                             | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npm run infra:up`                 | `../ops/dev.sh up`: infrastructure only                              |
| `npm run infra -- up <service...>` | Infrastructure + these services in containers (`all` = everything)   |
| `npm run infra:ps` / `infra:down`  | Status / stop the stack (data is kept)                               |
| `npm run infra -- <command>`       | Any `dev.sh` command: `logs <service>`, `build <service>`, `info`, … |

`./dev.sh up` prints the ports and the env values (`DATABASE_URL`, `REDIS_URL`, URLs of the other services). Docker
needs little memory for the infrastructure; images are built one at a time — give Docker at least 4 GiB if you
run the whole stack. Details: the `ops` README.

Every non-public request needs an access token from wallet-core. To try the API locally, sign one yourself with
the local-only secret (it is accepted only while the service runs with that secret):

```sh
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({ sub: '3c7e1a9b-5d2f-4b8e-9a6c-1f0d2e3b4a5c', permissions: ['wallet'] }, 'local-only-jwt-secret-change-me-0123456789', { issuer: 'wallet-core', expiresIn: '15m' }))")
curl -s localhost:3001/graphql -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"query":"{ me { id permissions } }"}'
```

## Scripts

| Script                                        | What it does                                                          |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `npm run start:dev`                           | Start with watch mode (also regenerates `schema.graphql`)             |
| `npm run build` / `npm run start:prod`        | Compile to `dist/` / run the compiled app                             |
| `npm run lint` / `npm run format`             | ESLint (type-aware) / Prettier                                        |
| `npm run typecheck`                           | `tsc --noEmit` over sources, tests and scripts                        |
| `npm test`                                    | Unit tests (`src/**/*.spec.ts`), no database needed                   |
| `npm run test:e2e`                            | End-to-end tests (`test/*.e2e-spec.ts`) against real MySQL + Redis    |
| `npm run test:cov`                            | Unit tests with coverage                                              |
| `npm run schema:generate`                     | Write `schema.graphql` from the resolvers without starting the server |
| `npm run migrate`                             | Apply pending Knex migrations                                         |
| `npm run migrate:make -- <name>`              | Create `migrations/<timestamp>_<name>.ts`                             |
| `npm run migrate:rollback` / `migrate:status` | Roll back the last batch / list migrations                            |

## Environment variables

Validated at startup (`src/config/env.schema.ts`); an invalid value stops the service with a clear message.
See `.env.example`.

| Variable                   | Default                                                          | Meaning                                                                              |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PORT`                     | `3001`                                                           | HTTP port                                                                            |
| `NODE_ENV`                 | `development`                                                    | `production` disables writing `schema.graphql`                                       |
| `APP_ENV`                  | `local`                                                          | Environment: `local`, `staging`, `kvitka-uat`, `wisla-uat`. Prefix of all Redis keys |
| `DATABASE_URL`             | `mysql://wallet:wallet@localhost:3306/rates_service`             | MySQL database of this service                                                       |
| `REDIS_URL`                | `redis://localhost:6379`                                         | Redis for events                                                                     |
| `CLIENT`                   | `demo`                                                           | Client this deployment serves: `demo`, `kvitka`, `wisla`                             |
| `CORS_ORIGINS`             | `http://localhost:5173,http://localhost:5174`                    | Allowed browser origins                                                              |
| `APP_VERSION`              | from `package.json`                                              | Version reported by `health`                                                         |
| `LOG_LEVEL`                | `info`                                                           | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`              |
| `JWT_ISSUER`               | `wallet-core`                                                    | Expected issuer of the access tokens                                                 |
| `JWT_SECRET`               | `local-only-jwt-secret-change-me-0123456789` (not in production) | HS256 secret shared with wallet-core. Required when `NODE_ENV=production`            |
| `THROTTLE_TTL_SECONDS`     | `60`                                                             | Length of the rate-limit window, in seconds                                          |
| `THROTTLE_LIMIT_ANONYMOUS` | `120`                                                            | Requests per window without a token (counted per client IP)                          |
| `THROTTLE_LIMIT_USER`      | `600`                                                            | Requests per window for a logged-in user or staff member (counted per id)            |

## GraphQL contract

The schema is **code-first**: resolvers and `@ObjectType`s are the source of truth, and the generated
`schema.graphql` at the repository root is **committed**. It is the contract other repositories
(`client-web`, `back-office`, `wallet-core`) build against — the frontends download it from `main`.

- `npm run start:dev` and the e2e tests regenerate it; `npm run schema:generate` does it without a database.
- A PR that changes the API must include the regenerated `schema.graphql`. That diff is what consumers review.

Current API: `health { service version appEnv client db redis }` (public), `me { id permissions strategy }` and the
subscription `serverTime` (see below).

### Subscriptions (WebSocket)

GraphQL subscriptions use the [graphql-ws](https://github.com/enisdenjo/graphql-ws) protocol on the same path,
`ws://localhost:3001/graphql`. `serverTime` emits the server time every second; it is the working example for live data
such as `rateUpdated`. Authentication goes into the connection params:

```ts
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'ws://localhost:3001/graphql',
  connectionParams: { Authorization: `Bearer ${accessToken}` },
});
client.subscribe(
  { query: 'subscription { serverTime }' },
  { next: console.log, error: console.error, complete: () => {} },
);
```

The implementation is in `src/server-time/`; the e2e test `test/server-time.e2e-spec.ts` covers it.

## Rate limits

Every request that reaches a resolver or a controller is counted against a key, and once the limit is reached
further requests are refused until the window ends. The global guard lives in `src/throttling` (`@nestjs/throttler`
with our own Redis storage). It runs after `AuthGuard`, so it knows who the caller is.

| Caller          | Key              | Default limit per window |
| --------------- | ---------------- | ------------------------ |
| Not logged in   | `ip:<client IP>` | 120                      |
| Logged-in user  | `user:<id>`      | 600                      |
| Logged-in staff | `staff:<id>`     | 600                      |

The window is 60 seconds. Limits and window come from `THROTTLE_LIMIT_ANONYMOUS`, `THROTTLE_LIMIT_USER` and
`THROTTLE_TTL_SECONDS` (see the environment variables above). To change a limit on an environment, set the variable
there (the mentor does it in Dokploy) and redeploy.

- **Fixed window.** The first request starts the window. Once the limit is exceeded, requests are refused until that
  window ends: limit hit at 0:10 of a 60 s window means refused until 1:00, not until 1:10. `Retry-After` is the
  number of seconds left in the window.
- **One HTTP request counts once**, however many top-level fields a GraphQL request has.
- **Shared and per service.** Counters live in Redis under `<APP_ENV>:throttle:<service>:<key>` (e.g.
  `staging:throttle:rates-service:user:42`), so all instances of a service share them and they survive a restart.
  The service name in the key makes each service count on its own, although all backends share one Redis.
- **Client IP.** Express trusts one proxy hop (`trust proxy = 1`, `src/configure-app.ts`, because Traefik is the
  only proxy), so the IP is the last `X-Forwarded-For` entry. A client cannot invent a new IP by adding entries.
- **Not counted:** `GET /health` (the controller is marked `@SkipThrottle()`) and everything that arrives over the
  WebSocket (subscriptions). The GraphQL query `health` is counted like any other query. There is no `/metrics`
  endpoint in this service.
- **Known limits (follow-ups):** a guard runs only when a resolver or controller is about to be called, so these
  requests are not counted: refused by `AuthGuard` (401) or `PermissionGuard` (403), GraphQL introspection
  (`__schema`, `__type`), and GraphQL documents that cannot be parsed or fail validation. Server-to-server calls are
  not exempt: when wallet-core starts calling this service (it does not yet), its calls are counted like any other
  caller's (`ip:<wallet-core IP>` without a token, `user:` / `staff:` if it forwards one). An exemption belongs
  with the real rates client.
- **Logging.** Only the first refused request of a caller in a window is logged (`request throttled`), so a flood of
  refused requests does not flood the logs.
- **Redis down.** Requests pass without a limit and a warning is logged at most once a minute. The `X-RateLimit-*`
  headers then show a full budget and mean nothing.
- An allowed response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds left);
  a refused one carries `Retry-After`.

### Error format (the contract for frontends)

GraphQL (the HTTP status stays 200, as for any GraphQL error):

```json
{
  "errors": [
    {
      "message": "Too many requests, try again later",
      "extensions": { "code": "TOO_MANY_REQUESTS", "retryAfterSeconds": 42 }
    }
  ]
}
```

REST: status `429` and the header `Retry-After: 42`. In both cases the number is the seconds until the window ends;
wait that long before retrying.

| Code                | When                        | Extra fields        |
| ------------------- | --------------------------- | ------------------- |
| `TOO_MANY_REQUESTS` | the limit of the key is hit | `retryAfterSeconds` |

## Logging

Structured JSON logs via [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) (`src/logging/`). One line per
event with `time`, `level`, `service`, `appEnv`, `client`, `context` (class) and `msg`; inside an HTTP request, a
GraphQL operation or an event handler also `requestId`. Locally (`npm run start:dev`, `NODE_ENV=development`) the
output is pretty-printed; deployed it is JSON and goes to Grafana (<https://logs.wallet.shatori.com>, see the
handbook's `logging.md`).

```ts
constructor(@InjectPinoLogger(LedgerService.name) private readonly logger: PinoLogger) {}

this.logger.info({ userId, conversionId, amount }, 'conversion booked'); // fields first, then a message
this.logger.error({ err, conversionId }, 'conversion failed'); // pass errors as `err`
```

- **`requestId`**: taken from the incoming `x-request-id` header (or generated) and returned in the response
  header. GraphQL subscriptions get one per websocket connection (`x-request-id` in `connectionParams`).
  `EventPublisher` puts it into the event meta and `EventSubscriber` handlers log with the same id, so one search
  shows a request across services. `POST /diagnostics/ping` (authenticated) publishes `system.ping`, which every
  backend logs — a quick end-to-end trace check.
- **Access log**: one line per HTTP request — method, path, GraphQL operation (`query Me`), status, `durationMs`.
  No bodies, no headers. `/health` probes are logged at `debug`.
- **Secrets are redacted** (`authorization`, `cookie`, `password`, `token`, `secret`, `apiKey`, … at any of the
  first four levels; see `SECRET_KEYS` in `src/logging/logger.options.ts`). Still: never log secrets or whole
  request objects on purpose.
- **`LOG_LEVEL`**: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent` (e2e tests default to `silent`).
- Do not use `console.*` or `new Logger()` from `@nestjs/common` in application code.

## Seams

Seams let you write business logic now and swap the stand-in for the real thing later without touching that logic.

### Auth — `src/auth`

A global `AuthGuard` asks the registered `AuthStrategy` list who the caller is. Every endpoint requires
authentication unless it is marked `@Public()`.

Callers send the access token issued by wallet-core:

```
Authorization: Bearer <access token>
```

`JwtAuthStrategy` verifies it locally, without calling wallet-core: the HS256 signature with `JWT_SECRET` (the same
secret as in wallet-core), the issuer (`JWT_ISSUER`) and the expiry. The user comes from the token: `sub` (UUID) is
`user.id`, the `permissions` claim is `user.permissions`. A missing, invalid or expired token → **401**.

It works for HTTP, GraphQL queries/mutations and GraphQL subscriptions (send `{ "Authorization": "Bearer <token>" }`
as graphql-ws `connectionParams`). The old `Authorization: Dev …` header is no longer accepted.

```ts
@Query(() => Balance)
balance(@CurrentUser() user: AuthUser) { /* user.id, user.permissions */ }

@Public()
@Query(() => PublicSettings)
publicSettings() { ... }
```

**Another way to authenticate** (e.g. service-to-service calls): implement `AuthStrategy`
(`src/auth/auth-strategy.ts`) and register it in `AuthModule` under `AUTH_STRATEGIES`. Business code does not change.

### Permissions — `src/permissions`

```ts
@RequirePermission('bo:users:modify')
@Mutation(() => User)
blockUser(...) { ... }
```

All listed permissions are required (class-level or method-level); missing → **403**. The permissions come
from the `permissions` claim of the access token.

### Client settings — `src/settings`

```ts
const phone = await settings.get('auth.phoneRequiredAt'); // 'signup' | 'firstTransfer' | 'never'
const google = await settings.get('auth.googleLogin'); // boolean
```

`ClientSettingsService.get(key)` is typed by the catalog in `src/settings/settings.schema.ts`. **Defaults live in
the code** (`config/settings.defaults.yaml`, validated at startup), so a fresh environment works with an empty database.
The real settings store is a later task: it keeps **only overrides** in this service's database (one environment =
one client = one database) and falls back to these defaults. Callers do not change.

To add a setting: declare it in `settings.schema.ts` and give it a default in `settings.defaults.yaml`.

### Current client — `AppConfig`

`AppConfig.client` is the `CLIENT` this deployment serves. Inject `AppConfig` instead of reading `process.env`.
The client customization module (hooks, client-only endpoints) is a separate task.

### Events — `src/events`

`catalog.ts` is the typed contract for Redis events, **identical in all three backends**:

| Event                  | Transport                       | Name                          |
| ---------------------- | ------------------------------- | ----------------------------- |
| `rate.tick`            | Redis pub/sub (fire-and-forget) | channel `rate.tick`           |
| `conversion.completed` | Redis Stream (must not be lost) | stream `conversion.completed` |
| `system.ping`          | Redis pub/sub (diagnostics)     | channel `system.ping`         |

```ts
await publisher.publish('conversion.completed', event); // XADD
const off = await subscriber.subscribe('rate.tick', (tick, meta) => ...); // SUBSCRIBE; meta.requestId
```

Stream consumers use consumer groups (`XREADGROUP` + `XACK`) and `decodeStreamEntry()`.
Change the catalog only via a contract PR in all three repositories.

**Environment prefix.** Several environments may share one Redis, so every channel and stream is prefixed with
`APP_ENV`: `staging:rate.tick`, `kvitka-uat:conversion.completed`. The helpers add the prefix; when you need a raw
name (e.g. a stream consumer) use `eventStream(appConfig.appEnv, 'conversion.completed')` / `eventChannel(...)`.

## Project layout

```
src/
  auth/          JWT auth: AuthGuard, JwtAuthStrategy, @CurrentUser, @Public, `me`
  permissions/   @RequirePermission + guard
  settings/      ClientSettingsService (defaults from config/settings.defaults.yaml)
  events/        event catalog + publisher/subscriber
  health/        GET /health and `health` query
  throttling/    global rate limit (guard + Redis storage), see Rate limits
  server-time/   example subscription `serverTime`
  config/        env validation + AppConfig
  database/      Knex (KNEX token)    redis/   ioredis (REDIS token)
  graphql/       Apollo options
migrations/      Knex migrations (timestamped)
test/            e2e tests
schema.graphql   generated GraphQL contract (committed)
```

One module per feature (`src/sources/`, `src/aggregation/`, …). Shared files (`app.module.ts`, `schema.graphql`)
change in small, dedicated PRs.

## Deployment

Every push to `main` (→ `staging`), `client/kvitka-uat` and `client/wisla-uat` runs `.github/workflows/deploy.yml`,
a thin caller of `ops/.github/workflows/deploy-service.yml`: the image is built in GitHub Actions, pushed to
`ghcr.io/internship-2026-multi-currency-wallet/rates-service:<env>-<sha>` (and `<env>-latest`), the environment's Dokploy
application is redeployed, and the job waits until `/health` reports the new commit SHA as `version`.
The container runs `npm run migrate && node dist/main.js`, so migrations are applied on every deploy.

| Environment  | Branch              | URL                                                               | `CLIENT` |
| ------------ | ------------------- | ----------------------------------------------------------------- | -------- |
| `staging`    | `main`              | <https://staging-rates.wallet.shatori.com/graphql> · `/health`    | `demo`   |
| `kvitka-uat` | `client/kvitka-uat` | <https://kvitka-uat-rates.wallet.shatori.com/graphql> · `/health` | `kvitka` |
| `wisla-uat`  | `client/wisla-uat`  | <https://wisla-uat-rates.wallet.shatori.com/graphql> · `/health`  | `wisla`  |

Deployed configuration (set in Dokploy, not in Git): `APP_ENV`, `CLIENT`, `JWT_SECRET` (the same value in
wallet-core, rates-service and treasury-service), `DATABASE_URL` (database
`<env>_rates_service`), `REDIS_URL`, `CORS_ORIGINS` (`https://<env>.wallet.shatori.com`,
`https://<env>-admin.wallet.shatori.com`), `NODE_OPTIONS`; `APP_VERSION` is baked into the image by CI.
Details: the `ops` README (_Deployment_).

## Docker

```sh
docker build -t rates-service .
docker run --rm -p 3001:3000 -e DATABASE_URL=... -e REDIS_URL=... rates-service
```

Multi-stage build on `node:26-alpine`, runs as the non-root `node` user. Run migrations with
`npm run migrate` inside the container (the `ops` compose stack does this on start).
