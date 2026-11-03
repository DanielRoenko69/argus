// Provider-free HTTP smoke: real Vite dev/preview servers, loopback-only fake Core.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const requests = [];
const backend = createHttpServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/api/__toolchain-smoke' || req.url === '/console-assets/__toolchain-smoke') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path:req.url, method:req.method, origin:req.headers.origin, host:req.headers.host }));
  } else { res.statusCode = 404; res.end('Unexpected proxy request'); }
});
let dev, built;
const origin = server => `http://127.0.0.1:${server.address().port}`;
async function freePort() {
  const probe = createHttpServer();
  await new Promise((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  return port;
}
const get = async url => {
  const response = await fetch(url, { signal:AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, url);
  return response;
};
try {
  await new Promise((done, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', done); });
  const loaded = await loadConfigFromFile({ command:'serve', mode:'development' }, resolve(root, 'vite.config.ts'));
  assert.ok(loaded);
  const { config } = loaded;
  assert.equal(config.base, '/chat-assets/');
  assert.equal(config.server.proxy['/api'].headers.origin, 'http://localhost:3000');
  assert.equal(config.server.proxy['/api'].changeOrigin, true);
  // No request can escape to the real Core or use its sessions/credentials.
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([key, value]) =>
    [key, { ...(typeof value === 'string' ? {} : value), target:origin(backend) }]));
  dev = await createServer({ ...config, root, configFile:false, envFile:false, logLevel:'error',
    server:{ ...config.server, host:'127.0.0.1', port:await freePort(), strictPort:true, open:false, proxy } });
  await dev.listen();
  const devBase = origin(dev.httpServer);
  assert.match(await (await get(devBase + '/chat-assets/')).text(), /id="root"/);
  const entry = await get(devBase + '/chat-assets/src/main.tsx');
  assert.match(entry.headers.get('content-type'), /javascript/);
  assert.match(await entry.text(), /createRoot/);
  const shared = resolve(root, '../argus-console/src/components/WorkspaceSidebar.tsx').replaceAll('\\', '/');
  assert.match(await (await get(devBase + '/chat-assets/@fs/' + shared)).text(), /WorkspaceSidebar/);
  const api = await fetch(devBase + '/api/__toolchain-smoke', { method:'POST',
    headers:{ origin:devBase, 'content-type':'application/json' }, body:'{}', signal:AbortSignal.timeout(15000) });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { path:'/api/__toolchain-smoke', method:'POST',
    origin:'http://localhost:3000', host:new URL(origin(backend)).host });
  assert.equal((await (await get(devBase + '/console-assets/__toolchain-smoke')).json()).path, '/console-assets/__toolchain-smoke');

  built = await preview({ ...config, root, configFile:false, envFile:false, logLevel:'error',
    preview:{ host:'127.0.0.1', port:await freePort(), strictPort:true, open:false, proxy:{} } });
  const builtBase = origin(built.httpServer);
  const html = await (await get(builtBase + '/chat-assets/')).text();
  const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  const css = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
  assert.ok(script?.startsWith('/chat-assets/assets/'));
  assert.ok(css?.startsWith('/chat-assets/assets/'));
  assert.match((await get(builtBase + script)).headers.get('content-type'), /javascript/);
  assert.match((await get(builtBase + css)).headers.get('content-type'), /css/);
  assert.deepEqual(requests, ['/api/__toolchain-smoke', '/console-assets/__toolchain-smoke']);
  console.log('Chat toolchain smoke passed: dev HTML, TSX, shared sidebar, API origin/host, brand proxy, built JS/CSS. No live API or model calls.');
} finally {
  await dev?.close();
  if (built) await built.close();
  backend.closeAllConnections();
  await new Promise(resolveClose => backend.close(resolveClose));
}
