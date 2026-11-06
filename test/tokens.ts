import { JwtService } from '@nestjs/jwt';
import type { TokenAudience } from '../src/auth/access-token.js';

export const TEST_USER_ID = '3c7e1a9b-5d2f-4b8e-9a6c-1f0d2e3b4a5c';

interface AccessTokenOptions {
  sub?: string;
  /** `null` leaves `aud` out, like a token issued before wallet-core added it. */
  aud?: TokenAudience | null;
  permissions?: string[];
  expiresIn?: number;
  secret?: string;
}

function testSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set (see test/setup-env.ts)');
  return secret;
}

export function accessToken({
  sub = TEST_USER_ID,
  aud = 'wallet',
  permissions = ['wallet'],
  expiresIn = 15 * 60,
  secret = testSecret(),
}: AccessTokenOptions = {}): string {
  return new JwtService().sign(
    { sub, ...(aud === null ? {} : { aud }), permissions },
    { secret, algorithm: 'HS256', issuer: 'wallet-core', expiresIn },
  );
}

export const bearer = (options?: AccessTokenOptions): string => `Bearer ${accessToken(options)}`;
