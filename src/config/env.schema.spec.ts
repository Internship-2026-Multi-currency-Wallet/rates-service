import { AppConfig } from './app-config.js';
import { LOCAL_JWT_SECRET, validateEnv } from './env.schema.js';

const required = { JWT_SECRET: 'x'.repeat(32) };

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv(required);
    expect(env.CLIENT).toBe('demo');
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(3001);
    expect(env.JWT_ISSUER).toBe('wallet-core');
  });

  it('parses CLIENT and PORT', () => {
    const env = validateEnv({ ...required, CLIENT: 'kvitka', PORT: '4000' });
    expect(env.CLIENT).toBe('kvitka');
    expect(env.PORT).toBe(4000);
  });

  it('treats empty values as unset', () => {
    expect(validateEnv({ ...required, CLIENT: '' }).CLIENT).toBe('demo');
  });

  it('rejects an unknown client with a readable message', () => {
    expect(() => validateEnv({ ...required, CLIENT: 'acme' })).toThrow(/CLIENT/);
  });

  it('defaults APP_ENV to local and validates it', () => {
    expect(validateEnv(required).APP_ENV).toBe('local');
    expect(validateEnv({ ...required, APP_ENV: 'kvitka-uat' }).APP_ENV).toBe('kvitka-uat');
    expect(() => validateEnv({ ...required, APP_ENV: 'production' })).toThrow(/APP_ENV/);
  });

  it('falls back to the local-only JWT_SECRET outside production', () => {
    expect(validateEnv({}).JWT_SECRET).toBe(LOCAL_JWT_SECRET);
    expect(validateEnv({ NODE_ENV: 'test', JWT_SECRET: '' }).JWT_SECRET).toBe(LOCAL_JWT_SECRET);
  });

  it('keeps an explicit JWT_SECRET', () => {
    expect(validateEnv(required).JWT_SECRET).toBe(required.JWT_SECRET);
  });

  it('requires JWT_SECRET in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET: is required/);
    expect(() => validateEnv({ NODE_ENV: 'production', JWT_SECRET: '' })).toThrow(
      /JWT_SECRET: is required/,
    );
    expect(validateEnv({ ...required, NODE_ENV: 'production' }).JWT_SECRET).toBe(
      required.JWT_SECRET,
    );
  });

  it('refuses a JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ JWT_SECRET: 'x'.repeat(31) })).toThrow(
      /JWT_SECRET: must be at least 32/,
    );
  });

  it('no longer knows DEV_AUTH', () => {
    expect(validateEnv({ ...required, DEV_AUTH: 'true' })).not.toHaveProperty('DEV_AUTH');
  });
});

describe('AppConfig', () => {
  it('exposes the current client and splits CORS origins', () => {
    const config = AppConfig.fromEnv({
      ...required,
      CLIENT: 'wisla',
      CORS_ORIGINS: 'http://a, http://b',
    });
    expect(config.client).toBe('wisla');
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
  });

  it('exposes the JWT settings', () => {
    expect(AppConfig.fromEnv(required).jwt).toEqual({
      issuer: 'wallet-core',
      secret: required.JWT_SECRET,
    });
  });
});
