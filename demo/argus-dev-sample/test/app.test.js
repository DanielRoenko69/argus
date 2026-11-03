import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

let server;
let baseUrl;

before(async () => {
  server = createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('health endpoint identifies the service', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'argus-dev-sample' });
  assert.ok(response.headers.get('x-request-id'));
});

test('service catalog can be filtered by tier', async () => {
  const response = await fetch(`${baseUrl}/api/services?tier=critical`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.deepEqual(body.services.map(service => service.id), ['catalog', 'checkout']);
});

test('unknown routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});
