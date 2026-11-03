import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || 4100);
const sessionId = 'argus-e2e-mcp-session';

function send(res, status, value, headers = {}) {
  const body = value == null ? '' : JSON.stringify(value);
  res.writeHead(status, {
    ...(body ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) } : {}),
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const policySecret = 'argus-e2e-policy-secret';
let goldenPathSlackAttempts = 0;

function handlePrometheus(url, req, res) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/v1/status/buildinfo') {
    send(res, 200, {
      status: 'success',
      data: { version: 'argus-e2e-prometheus', revision: 'deterministic' },
    });
    return true;
  }
  if (url.pathname === '/api/v1/query') {
    send(res, 200, {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{
          metric: { __name__: url.searchParams.get('query') || 'up', fixture: 'ARGUS_E2E_PROMETHEUS_OK' },
          value: [1_775_304_000, '1'],
        }],
      },
    });
    return true;
  }
  if (url.pathname === '/api/v1/query_range') {
    send(res, 200, {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [{
          metric: { __name__: url.searchParams.get('query') || 'up', fixture: 'ARGUS_E2E_PROMETHEUS_RANGE_OK' },
          values: [[1_775_304_000, '1'], [1_775_304_060, '1']],
        }],
      },
    });
    return true;
  }
  if (url.pathname === '/api/v1/alerts') {
    send(res, 200, {
      status: 'success',
      data: { alerts: [{ labels: { alertname: 'ArgusFixture' }, state: 'firing', marker: 'ARGUS_E2E_PROMETHEUS_ALERTS_OK' }] },
    });
    return true;
  }
  if (url.pathname === '/api/v1/targets') {
    send(res, 200, {
      status: 'success',
      data: { activeTargets: [{ health: 'up', state: url.searchParams.get('state'), marker: 'ARGUS_E2E_PROMETHEUS_TARGETS_OK' }] },
    });
    return true;
  }
  const labelValues = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(url.pathname);
  if (labelValues) {
    send(res, 200, {
      status: 'success',
      data: ['ARGUS_E2E_PROMETHEUS_LABEL_VALUES_OK', decodeURIComponent(labelValues[1])],
    });
    return true;
  }
  return false;
}

async function handlePolicy(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const expected = `sha256=${createHmac('sha256', policySecret).update(raw).digest('hex')}`;
  const received = String(req.headers['x-argus-signature'] || '');
  const signatureValid = received.length === expected.length
    && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!signatureValid) return send(res, 401, { allow: false, reason: 'invalid HMAC signature' });
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { allow: false, reason: 'invalid JSON' }); }
  if (payload.tool_name === 'e2e_fabric_fabric_status') {
    return send(res, 200, { allow: false, reason: 'ARGUS_E2E_CHANGE_FREEZE' });
  }
  return send(res, 200, { allow: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (handlePrometheus(url, req, res)) return;
  if (req.method === 'POST' && path === '/policy/decide') return handlePolicy(req, res);
  if (req.method === 'POST' && path === '/golden-path/slack-flaky') {
    goldenPathSlackAttempts += 1;
    if (goldenPathSlackAttempts === 1) {
      req.socket.destroy(new Error('ARGUS_E2E_SLACK_TRANSIENT_FAILURE'));
      return;
    }
    return send(res, 200, { status: 'ARGUS_E2E_SLACK_MESSAGE_WRITTEN_AFTER_RETRY', attempt: goldenPathSlackAttempts });
  }
  if (path !== '/mcp') return send(res, 404, { error: 'not found' });
  if (req.method === 'DELETE') return send(res, 204, null);
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  let message;
  try { message = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }
  if (message.id == null) return send(res, 202, null, { 'mcp-session-id': sessionId });

  const result = message.method === 'initialize'
    ? {
        protocolVersion: message.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'argus-e2e-mcp', version: '1.0.0' },
      }
    : message.method === 'tools/list'
      ? {
          tools: [{
            name: 'fabric_status',
            description: 'Returns a deterministic status from the Argus E2E remote MCP fixture.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          }],
        }
      : message.method === 'tools/call'
        ? {
            content: [{ type: 'text', text: 'ARGUS_E2E_MCP_FIXTURE_OK' }],
            isError: false,
          }
        : message.method === 'ping'
          ? {}
          : null;

  if (result == null) {
    return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }, { 'mcp-session-id': sessionId });
  }
  return send(res, 200, { jsonrpc: '2.0', id: message.id, result }, { 'mcp-session-id': sessionId });
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`Argus E2E MCP fixture listening on ${port}\n`));
