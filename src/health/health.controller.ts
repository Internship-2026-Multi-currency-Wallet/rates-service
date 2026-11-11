import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { DependencyStatus, type Health } from './health.model.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness/readiness probe. 503 when the database is down. Redis alone being down is
   * `degraded` with 200: the service still serves requests and its Redis clients reconnect
   * on their own, so restarting it would not help.
   */
  @Public()
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<Health & { status: string }> {
    const health = await this.health.check();
    const dbUp = health.db === DependencyStatus.UP;
    const ok = dbUp && health.redis === DependencyStatus.UP;
    res.status(dbUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', ...health };
  }
}
