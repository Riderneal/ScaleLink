const { nanoid } = require('nanoid');
const { getRedisClient } = require('../config/redis');
const env = require('../config/env');

const CODE_LENGTH = 7;
const URL_KEY_PREFIX = 'url:'; // url:{code} -> original URL
const CLICKS_KEY_PREFIX = 'clicks:'; // clicks:{code} -> integer counter

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function shorten(req, res, next) {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !isValidUrl(url)) {
      return res.status(400).json({ error: 'A valid http(s) URL is required' });
    }

    const redis = getRedisClient();
    let code;
    let attempts = 0;

    // Collision retry loop - astronomically unlikely at this ID space, but
    // correctness under a shared keyspace across N stateless instances is
    // exactly the kind of thing worth being explicit about.
    do {
      code = nanoid(CODE_LENGTH);
      attempts += 1;
    } while ((await redis.exists(URL_KEY_PREFIX + code)) && attempts < 5);

    await redis.set(URL_KEY_PREFIX + code, url);
    await redis.set(CLICKS_KEY_PREFIX + code, 0);

    return res.status(201).json({
      code,
      shortUrl: `${env.baseUrl}/${code}`,
      originalUrl: url,
      servedBy: env.instanceId,
    });
  } catch (err) {
    next(err);
  }
}

async function redirect(req, res, next) {
  try {
    const { code } = req.params;
    const redis = getRedisClient();

    const originalUrl = await redis.get(URL_KEY_PREFIX + code);
    if (!originalUrl) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    // Fire-and-forget increment: don't make the redirect (the hot path)
    // wait on analytics bookkeeping.
    redis.incr(CLICKS_KEY_PREFIX + code).catch((err) => {
      console.error('[redirect] failed to increment click count:', err.message);
    });

    return res.redirect(302, originalUrl);
  } catch (err) {
    next(err);
  }
}

async function stats(req, res, next) {
  try {
    const { code } = req.params;
    const redis = getRedisClient();

    const [originalUrl, clicks] = await Promise.all([
      redis.get(URL_KEY_PREFIX + code),
      redis.get(CLICKS_KEY_PREFIX + code),
    ]);

    if (!originalUrl) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    return res.json({
      code,
      originalUrl,
      clicks: Number(clicks || 0),
      servedBy: env.instanceId,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { shorten, redirect, stats };
