const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const pino = require('pino');

const env = require('./config/env');
const { apiRouter, redirectRouter } = require('./routes/linkRoutes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const logger = pino({ level: env.nodeEnv === 'test' ? 'silent' : 'info' });

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '10kb' }));

  // Behind the Azure Load Balancer, the LB's IP would otherwise be all
  // req.ip ever sees, collapsing every real client into one rate-limit
  // bucket. Trusting the proxy lets Express derive the real client IP from
  // X-Forwarded-For - correct behavior for any service sitting behind a
  // load balancer, and also what makes the k6 load test's simulated
  // per-client IPs (see loadtest/k6-script.js) actually exercise
  // *separate* rate-limit buckets instead of one shared one.
  app.set('trust proxy', true);
  if (env.nodeEnv !== 'test') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  }

  // Health check also reports which instance answered - useful during the
  // load test to visually confirm the load balancer is actually spreading
  // traffic across both app VMs, not just hammering one.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', instance: env.instanceId, env: env.nodeEnv });
  });

  app.use('/api', apiRouter);
  // Root-level redirect matches the shortUrl format returned by /api/shorten
  app.use('/', redirectRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
