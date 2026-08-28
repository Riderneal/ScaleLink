import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Usage:
//   k6 run -e BASE_URL=http://<load_balancer_public_ip> loadtest/k6-script.js
//
// Run this AFTER `terraform apply` finishes and the app VMs have had a
// couple of minutes to finish their cloud-init bootstrap (installing
// Docker, cloning the repo, building the image). Hit /health a few times
// manually first to confirm both instances are actually up.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

const rateLimited = new Counter('rate_limited_responses');
const created = new Counter('created_responses');
const shortenLatency = new Trend('shorten_latency_ms');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    // Ramps up gradually so you can see the throughput ceiling rather than
    // just slamming the service at max concurrency from second zero.
    ramping_throughput: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 500,
      stages: [
        { target: 100, duration: '20s' },
        { target: 500, duration: '30s' },
        { target: 1000, duration: '30s' },
        { target: 1000, duration: '20s' }, // hold at peak to see steady-state p99
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'], // fails the run if p99 exceeds this - tune per your results
  },
};

export default function () {
  const payload = JSON.stringify({ url: `https://example.com/loadtest/${__VU}/${__ITER}` });

  // Simulate a distinct real client per virtual user (this is what a real
  // population of users hitting the service would look like) so the
  // per-IP rate limiter doesn't collapse every k6 VU into one shared
  // bucket. The service trusts X-Forwarded-For (see src/app.js) exactly
  // as it would behind any real load balancer or CDN.
  const fakeClientIp = `10.${(__VU >> 8) % 256}.${__VU % 256}.${(__ITER % 250) + 1}`;
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': fakeClientIp,
    },
  };

  const res = http.post(`${BASE_URL}/api/shorten`, payload, params);

  shortenLatency.add(res.timings.duration);

  if (res.status === 201) {
    created.add(1);
  } else if (res.status === 429) {
    rateLimited.add(1);
  }

  check(res, {
    'status is 201 or 429': (r) => r.status === 201 || r.status === 429,
  });
}

export function handleSummary(data) {
  const p50 = data.metrics.http_req_duration.values['med'];
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const p99 = data.metrics.http_req_duration.values['p(99)'];
  const rps = data.metrics.http_reqs.values.rate;

  console.log('\n=== ScaleLink Load Test Summary ===');
  console.log(`Requests/sec (avg): ${rps.toFixed(1)}`);
  console.log(`Latency p50/p95/p99 (ms): ${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)}`);
  console.log(`Total requests: ${data.metrics.http_reqs.values.count}`);
  console.log('This is the number to quote on the resume: e.g.');
  console.log(`  "handled ${Math.round(rps)} req/sec at p99 ${p99.toFixed(0)}ms across 2 load-balanced instances"`);

  return {
    stdout: JSON.stringify(data, null, 2), // keep default JSON output too
  };
}
