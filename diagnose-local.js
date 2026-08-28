/**
 * Diagnostic: fires 50 rapid requests directly at your local nginx (port
 * 8080), each with a DIFFERENT simulated client IP via X-Forwarded-For -
 * the same technique the k6 test uses - to see if premature rate-limiting
 * happens even without k6 or the Cloudflare tunnel involved.
 *
 * Run from the project root: node diagnose-local.js
 */
async function main() {
  const results = [];
  for (let i = 0; i < 50; i++) {
    const fakeIp = `10.99.${Math.floor(i / 250)}.${i % 250}`;
    const res = await fetch('http://localhost:8080/api/shorten', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': fakeIp,
      },
      body: JSON.stringify({ url: `https://example.com/diag/${i}` }),
    });
    const servedBy = res.headers.get('x-served-by');
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');
    results.push({ i, ip: fakeIp, status: res.status, servedBy, limit, remaining });
    console.log(
      `req ${String(i).padStart(2)}: ip=${fakeIp.padEnd(14)} status=${res.status} served_by=${servedBy} limit=${limit} remaining=${remaining}`
    );
  }

  const blocked = results.filter((r) => r.status === 429).length;
  console.log(`\nBlocked: ${blocked} / 50`);
  console.log(
    blocked === 0
      ? 'PASS: no false blocking locally - the issue is specific to the k6/tunnel path'
      : 'FAIL: blocking reproduces even locally - real config issue found, not a k6/tunnel artifact'
  );
}

main().catch((err) => {
  console.error('Diagnostic failed:', err.message);
  process.exit(1);
});
