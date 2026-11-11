/**
 * Writes `schema.graphql` from the code-first resolvers without serving traffic.
 * Schema generation must remain usable without Redis.
 *
 *   npm run schema:generate
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

process.env.NODE_ENV = 'development';
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await app.init();
await app.close();
process.stdout.write('schema.graphql written\n');
