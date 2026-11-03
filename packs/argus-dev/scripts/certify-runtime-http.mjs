/** Provider-free real-time regression for Node's old 300-second header boundary.
 * Run after npm run build: node scripts/certify-runtime-http.mjs
 * Uses loopback only; no credentials, model calls, workspace or workflow writes.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runtimeHttpOptions } from '../dist/runtimeHttp.js';

const delayMs = 305_000;
let requests = 0;
const timers = new Set();
const server = http.createServer((_req, res) => {
  requests++;
  const timer = setTimeout(() => {
    timers.delete(timer);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: 'delayed fixture result' }));
  }, delayMs);
  timers.add(timer);
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  console.log(`Waiting ${delayMs / 1000}s for fixture response headers using ${process.version}; no provider calls.`);
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/run`, runtimeHttpOptions(900));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { response: 'delayed fixture result' });
  assert.equal(requests, 1);
  assert.ok(Date.now() - started >= delayMs);
  console.log(`PASS: HTTP response received after ${Date.now() - started}ms; one request, no retry.`);
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
