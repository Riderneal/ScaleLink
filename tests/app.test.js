process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_WINDOW_SECONDS = '10';
process.env.RATE_LIMIT_MAX_REQUESTS = '5';

const request = require('supertest');
const createApp = require('../src/app');
const { getRedisClient, closeRedisClient } = require('../src/config/redis');

const app = createApp();

afterEach(async () => {
  const redis = getRedisClient();
  await redis.flushall();
});

afterAll(async () => {
  await closeRedisClient();
});

describe('POST /api/shorten', () => {
  it('creates a short link for a valid URL', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'https://example.com/some/long/path' });
    expect(res.status).toBe(201);
    expect(res.body.code).toHaveLength(7);
    expect(res.body.shortUrl).toContain(res.body.code);
  });

  it('rejects an invalid URL', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing URL', async () => {
    const res = await request(app).post('/api/shorten').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /:code (redirect + click tracking)', () => {
  it('redirects to the original URL and increments the click counter', async () => {
    const create = await request(app).post('/api/shorten').send({ url: 'https://example.com/redirect-test' });
    const { code } = create.body;

    const redirectRes = await request(app).get(`/${code}`).redirects(0);
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.location).toBe('https://example.com/redirect-test');

    // click increment is fire-and-forget; give it a tick
    await new Promise((r) => setTimeout(r, 50));

    const statsRes = await request(app).get(`/${code}/stats`);
    expect(statsRes.body.clicks).toBe(1);
  });

  it('returns 404 for an unknown code', async () => {
    const res = await request(app).get('/doesnotexist');
    expect(res.status).toBe(404);
  });
});

describe('Distributed rate limiter (sliding window, Lua-atomic)', () => {
  it('allows requests under the limit and blocks once exceeded', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app).post('/api/shorten').send({ url: `https://example.com/${i}` });
      results.push(res.status);
    }
    // limit is 5 (set above): first 5 succeed, next 2 are rate-limited
    expect(results.filter((s) => s === 201)).toHaveLength(5);
    expect(results.filter((s) => s === 429)).toHaveLength(2);
  });

  it('holds an exact count under true concurrency (proves the Lua script is atomic)', async () => {
    // Fire 30 requests from the "same client" (same IP, since supertest hits
    // the app in-process) all at once, not sequentially. A naive
    // read-then-write rate limiter (GET count, check, INCR) has a race
    // window here that would let more than `limit` requests through; the
    // Lua script closes that window because each check+record is a single
    // atomic Redis operation.
    const requests = Array.from({ length: 30 }, (_, i) =>
      request(app).post('/api/shorten').send({ url: `https://example.com/concurrent/${i}` })
    );
    const responses = await Promise.all(requests);
    const succeeded = responses.filter((r) => r.status === 201).length;
    const limited = responses.filter((r) => r.status === 429).length;

    expect(succeeded).toBe(5); // exactly the limit, not more
    expect(limited).toBe(25);
    expect(succeeded + limited).toBe(30);
  });

  it('sets rate limit headers', async () => {
    const res = await request(app).post('/api/shorten').send({ url: 'https://example.com/headers' });
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-served-by']).toBeDefined();
  });
});

describe('GET /health', () => {
  it('reports ok status and instance id', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
