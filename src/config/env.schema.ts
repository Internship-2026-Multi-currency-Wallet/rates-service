import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.options.js';

/** Clients this codebase knows about. Each deployment serves exactly one of them. */
export const KNOWN_CLIENTS = ['demo', 'kvitka', 'wisla'] as const;
export type ClientCode = (typeof KNOWN_CLIENTS)[number];

/**
 * Environment this deployment belongs to. Prefixes all Redis keys (`kvitka-uat:rate.tick`),
 * so several environments can share one Redis.
 */
export const APP_ENVS = ['local', 'staging', 'kvitka-uat', 'wisla-uat'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Local startup must work without provisioning a shared signing secret. */
export const LOCAL_JWT_SECRET = 'local-only-jwt-secret-change-me-0123456789';

/**
 * Environment variables of the service. Validated once at startup:
 * a missing or invalid value stops the process with a clear message.
 * Keep `.env.example` in sync with this schema.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(APP_ENVS).default('local'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.url().default('mysql://wallet:wallet@localhost:3306/rates_service'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    CLIENT: z.enum(KNOWN_CLIENTS).default('demo'),
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
    APP_VERSION: z.string().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    JWT_ISSUER: z.string().min(1).default('wallet-core'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  })
  .transform((env, ctx) => {
    if (env.JWT_SECRET === undefined && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'is required in production (the HS256 secret shared with wallet-core)',
      });
      return z.NEVER;
    }
    return { ...env, JWT_SECRET: env.JWT_SECRET ?? LOCAL_JWT_SECRET };
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  // Treat empty strings as "not set", so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
