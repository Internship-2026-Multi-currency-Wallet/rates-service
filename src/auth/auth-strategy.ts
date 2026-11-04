import type { AuthUser } from './auth-user.js';

/** What a strategy gets to look at. Same shape for HTTP, GraphQL and GraphQL websocket requests. */
export interface AuthRequest {
  /** Raw `Authorization` header (or `Authorization` websocket connection param). */
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Unsupported credentials return null to allow another strategy; invalid credentials must throw
 * to prevent authentication fallback.
 */
export interface AuthStrategy {
  readonly name: string;
  authenticate(request: AuthRequest): Promise<AuthUser | null> | AuthUser | null;
}

/** Injection token: an ordered list of `AuthStrategy` instances. */
export const AUTH_STRATEGIES = Symbol('AUTH_STRATEGIES');
