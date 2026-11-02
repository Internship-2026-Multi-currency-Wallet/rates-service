import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_STRATEGIES, type AuthStrategy } from './auth-strategy.js';
import { AuthGuard } from './auth.guard.js';
import { JwtAuthStrategy } from './jwt-auth.strategy.js';
import { MeResolver } from './me.resolver.js';
import { PermissionGuard } from '../permissions/permission.guard.js';

/**
 * Authentication seam.
 *
 * Callers send the access token issued by wallet-core (`Authorization: Bearer <jwt>`);
 * `JwtAuthStrategy` verifies it locally. Business code only uses `@CurrentUser()`, `@Public()`
 * and `@RequirePermission()`.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [
    JwtAuthStrategy,
    {
      provide: AUTH_STRATEGIES,
      inject: [JwtAuthStrategy],
      useFactory: (jwt: JwtAuthStrategy): AuthStrategy[] => [jwt],
    },
    // Order matters: authenticate first, then check permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    MeResolver,
  ],
  exports: [AUTH_STRATEGIES],
})
export class AuthModule {}
