import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { boundedLongRequestTimeoutMs, postLongRunningJson } from './longHttp.js';

test('bounds the long-running internal agent timeout', () => {
  assert.equal(boundedLongRequestTimeoutMs(undefined), 900_000);
  assert.equal(boundedLongRequestTimeoutMs('1'), 30_000);
  assert.equal(boundedLongRequestTimeoutMs('99999999'), 1_800_000);
  assert.equal(boundedLongRequestTimeoutMs('600000'), 600_000);
});

test('posts JSON through the explicit long-running HTTP boundary', async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ received: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await postLongRunningJson(
      `http://127.0.0.1:${address.port}/agent`,
      { 'Content-Type': 'application/json' },
      { message: 'bounded' },
      30_000,
    );
    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(response.body), { received: { message: 'bounded' } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
