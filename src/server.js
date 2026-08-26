const createApp = require('./app');
const env = require('./config/env');
const { getRedisClient } = require('./config/redis');

getRedisClient(); // eagerly connect, logs on success

const app = createApp();
const server = app.listen(env.port, () => {
  console.log(`[server] instance=${env.instanceId} listening on port ${env.port} (${env.nodeEnv})`);
});

const shutdown = (signal) => {
  console.log(`[server] received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
