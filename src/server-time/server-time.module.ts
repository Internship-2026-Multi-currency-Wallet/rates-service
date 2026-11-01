import { Module } from '@nestjs/common';
import { ServerTimeResolver } from './server-time.resolver.js';

@Module({ providers: [ServerTimeResolver] })
export class ServerTimeModule {}
