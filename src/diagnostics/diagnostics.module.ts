/**
 * Diagnostics: trace one request across the backends of an environment.
 * This file is IDENTICAL in wallet-core, rates-service and treasury-service.
 *
 *   curl -X POST https://staging-wallet-core.wallet.shatori.com/diagnostics/ping \
 *     -H 'Authorization: Dev 1:wallet' -H 'x-request-id: trace-123'
 *
 * The service publishes `system.ping`; every backend of the environment logs
 * "system.ping received" with the same `requestId` — search it in Grafana.
 */
import {
  Controller,
  HttpCode,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppConfig } from '../config/app-config.js';
import { EventPublisher, EventSubscriber, type Unsubscribe } from '../events/event-bus.js';
import { redisErrorReason } from '../redis/redis-connection.js';

@Controller('diagnostics')
export class DiagnosticsController {
  constructor(
    @Inject(EventPublisher) private readonly publisher: EventPublisher,
    @Inject(AppConfig) private readonly config: AppConfig,
    @InjectPinoLogger(DiagnosticsController.name) private readonly logger: PinoLogger,
  ) {}

  /** Publishes `system.ping` (any authenticated user). */
  @Post('ping')
  @HttpCode(200)
  async ping(@CurrentUser() user: AuthUser): Promise<{ published: true }> {
    try {
      // Bounded: the shared Redis client has a command timeout.
      await this.publisher.publish('system.ping', {
        v: 1,
        from: this.config.serviceName,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        { userId: user.id, reason: redisErrorReason(err) },
        'system.ping not published: Redis unavailable',
      );
      throw new ServiceUnavailableException('Redis unavailable');
    }
    this.logger.info({ userId: user.id }, 'system.ping published');
    return { published: true };
  }
}

@Module({ controllers: [DiagnosticsController] })
export class DiagnosticsModule implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: Unsubscribe;
  private closing = false;

  constructor(
    @Inject(EventSubscriber) private readonly subscriber: EventSubscriber,
    @InjectPinoLogger(DiagnosticsModule.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Not awaited: startup must not depend on Redis. While Redis is down the SUBSCRIBE stays
   * queued on the subscriber connection and completes once Redis is reachable.
   */
  onModuleInit(): void {
    this.subscriber
      .subscribe('system.ping', (ping, meta) => {
        this.logger.info(
          { from: ping.from, publishedAt: meta.publishedAt },
          `system.ping received from ${ping.from}`,
        );
      })
      .then(
        (unsubscribe) => {
          if (this.closing) return void unsubscribe().catch(() => undefined);
          this.unsubscribe = unsubscribe;
          this.logger.debug('subscribed to system.ping');
        },
        (err: unknown) => {
          const fields = { reason: redisErrorReason(err) };
          if (this.closing) this.logger.debug(fields, 'system.ping subscription cancelled');
          else this.logger.warn(fields, 'system.ping subscription failed');
        },
      );
  }

  /**
   * Not awaited: an UNSUBSCRIBE pending on a dropped connection must not hold up shutdown;
   * `EventsModule` closes the subscriber connection afterwards.
   */
  onModuleDestroy(): void {
    this.closing = true;
    this.unsubscribe?.().catch((err: unknown) =>
      this.logger.debug({ reason: redisErrorReason(err) }, 'system.ping unsubscribe failed'),
    );
  }
}
