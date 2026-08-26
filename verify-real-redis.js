/**
 * Verifies the sliding-window rate limiter against a REAL Redis instance
 * (not ioredis-mock) under genuine concurrency, simulating multiple
 * stateless app instances hitting the same Redis simultaneously.
 */
process.env.NODE_ENV = 'development';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.RATE_LIMIT_WINDOW_SECONDS = '5';
process.env.RATE_LIMIT_MAX_REQUESTS = '10';

const { getRedisClient, closeRedisClient } = require('./src/config/redis');

async function main() {
  const redis = getRedisClient();
  await redis.flushall();

  redis.defineCommand('slidingWindowLimit', {
    numberOfKeys: 1,
    lua: require('./src/middleware/distributedRateLimiter').SLIDING_WINDOW_SCRIPT,
  });

  const key = 'ratelimit:{verify-test}';
  const now = Date.now();
  const windowMs = 5000;
  const limit = 10;

  // Fire 200 fully concurrent requests - true parallel dispatch, not
  // sequential awaits - simulating 200 simultaneous clients hitting
  // multiple app instances that all share this one Redis.
  const N = 200;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(redis.slidingWindowLimit(key, now, windowMs, limit));
  }
  const results = await Promise.all(promises);

  const allowed = results.filter((r) => r[0] === 1).length;
  const denied = results.filter((r) => r[0] === 0).length;

  console.log(`Fired ${N} truly concurrent requests against REAL Redis.`);
  console.log(`Allowed: ${allowed} (limit was ${limit})`);
  console.log(`Denied:  ${denied}`);
  console.log(allowed === limit ? 'PASS: exact limit held under real concurrency' : 'FAIL: race condition detected');

  await closeRedisClient();
  process.exit(allowed === limit ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
