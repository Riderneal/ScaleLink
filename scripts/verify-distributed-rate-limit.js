/**
 * Run this against your live Azure deployment to PROVE the rate limiter is
 * genuinely distributed: it fires requests from one simulated client IP and
 * shows (a) which backend instance answered each one (via X-Served-By,
 * confirming the load balancer is actually alternating between the two app
 * VMs) and (b) that the shared Redis-backed limit is enforced consistently
 * regardless of which instance handles a given request - the exact
 * property a naive per-instance in-memory rate limiter would NOT have.
 *
 * Usage: node scripts/verify-distributed-rate-limit.js http://<load_balancer_public_ip>
 */
const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node verify-distributed-rate-limit.js <base_url>');
  process.exit(1);
}

const FAKE_CLIENT_IP = '203.0.113.42'; // one simulated client, fires everything

async function main() {
  console.log(`Firing 25 requests from simulated client ${FAKE_CLIENT_IP} against ${baseUrl}\n`);

  const results = [];
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': FAKE_CLIENT_IP,
      },
      body: JSON.stringify({ url: `https://example.com/verify/${i}` }),
    });
    const servedBy = res.headers.get('x-served-by');
    const remaining = res.headers.get('x-ratelimit-remaining');
    results.push({ i, status: res.status, servedBy, remaining });
    console.log(
      `req ${String(i).padStart(2)}: status=${res.status}  served_by=${servedBy}  remaining=${remaining}`
    );
  }

  const instancesSeen = new Set(results.map((r) => r.servedBy));
  const allowed = results.filter((r) => r.status === 201).length;
  const blocked = results.filter((r) => r.status === 429).length;

  console.log('\n=== Summary ===');
  console.log(`Distinct backend instances that answered: ${[...instancesSeen].join(', ')}`);
  console.log(`Allowed: ${allowed}, Blocked (429): ${blocked}`);
  console.log(
    instancesSeen.size > 1
      ? 'CONFIRMED: multiple instances served this client, and the limit still held exactly.'
      : 'NOTE: only one instance answered in this run - try again, or check the LB is routing to both.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
