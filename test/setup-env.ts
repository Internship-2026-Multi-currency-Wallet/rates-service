// Defaults for e2e runs: the local docker-compose MySQL/Redis and a test-only JWT secret.
process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'e2e-only-jwt-secret-0123456789-abcdefgh';
process.env.DATABASE_URL ??= 'mysql://wallet:wallet@localhost:3306/rates_service';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.METRICS_PORT ??= '0';
// The JSON access log would flood the test output; set LOG_LEVEL=info to see it.
process.env.LOG_LEVEL ??= 'silent';
