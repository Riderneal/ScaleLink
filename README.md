# ScaleLink — Distributed URL Shortener & Rate Limiter

A URL shortener whose actual point is the infrastructure underneath it:
two stateless app instances behind an Azure Load Balancer, a shared Redis
backing both persistence and a genuinely atomic distributed rate limiter,
provisioned entirely with Terraform, and load-tested to a real
requests-per-second number.

## Why this exists

Most portfolio "distributed system" projects are a single server with a
Redis client. This one is built to actually exercise the distributed part:
correctness is verified under true concurrency (not sequential requests),
across multiple real instances (not one process pretending), talking to
real infrastructure (not a mock).

## What's actually distributed here

- **Atomic rate limiting**: a Lua script (`src/middleware/distributedRateLimiter.js`)
  implements a sliding-window-log limiter as a single atomic Redis operation.
  Verified two ways: 30 truly concurrent requests against `ioredis-mock`
  (unit test), and 200 truly concurrent requests against a real Redis
  instance (`node verify-real-redis.js`) — both hold the limit exactly.
- **Shared state across instances**: two app VMs, no session affinity, both
  reading/writing the same Redis. `scripts/verify-distributed-rate-limit.js`
  proves this live against a real deployment: it shows both instances
  answering requests from one simulated client while the shared limit still
  holds.
- **Real throughput number**: `loadtest/k6-script.js` ramps to 1,000 req/sec
  against the live load balancer and reports p50/p95/p99 latency plus
  aggregate throughput — not an estimate, a measured result from the actual
  deployed infrastructure.

## Stack

Node.js, Express, Redis (ioredis, Lua scripting), Terraform, Azure
(Load Balancer, Linux VMs, NAT Gateway, VNet), Docker, k6.

## Local development

```bash
npm install
docker compose up -d redis   # or run redis-server locally
npm run dev                   # or: node src/server.js
```

## Tests

```bash
npm test                      # 9 tests: shortener logic + atomic rate limiter
node verify-real-redis.js     # 200-request true-concurrency check against real Redis
```

## Deploying to Azure

See [DEPLOY.md](./DEPLOY.md) for the full step-by-step (Azure for Students
signup, Terraform apply, load testing, teardown). No credit card required.

## Project structure

```
src/
  app.js                          Express app assembly
  server.js                       entrypoint
  config/                         env, Redis client
  controllers/linkController.js   shorten / redirect / stats
  middleware/distributedRateLimiter.js   the atomic Lua-based limiter
  routes/                         route definitions
terraform/                        Azure infra: VMs, LB, VNet, NAT Gateway
loadtest/k6-script.js             the load test that produces the resume number
scripts/verify-distributed-rate-limit.js   proves cross-instance correctness live
tests/                            Jest suite
```
