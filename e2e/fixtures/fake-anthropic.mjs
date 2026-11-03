import http from 'node:http';

const port = Number(process.env.PORT || 4100);
const seenTransientFaults = new Set();

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map(item => {
    if (typeof item === 'string') return item;
    if (item?.type === 'text') return item.text || '';
    if (item?.type === 'tool_result') return item.content || '';
    return '';
  }).join('\n');
}

function faultMarker(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = messages.map(contentOf).join('\n').toUpperCase();
  if (text.includes('ARGUS_E2E_FAULT_TRANSIENT_429')) return '429-once';
  if (text.includes('ARGUS_E2E_FAULT_TRANSIENT_500')) return '500-once';
  if (text.includes('ARGUS_E2E_FAULT_401')) return '401';
  if (text.includes('ARGUS_E2E_FAULT_429')) return '429';
  if (text.includes('ARGUS_E2E_FAULT_500')) return '500';
  if (text.includes('ARGUS_E2E_FAULT_TIMEOUT')) return 'timeout';
  return null;
}

async function respondFault(res, body) {
  const fault = faultMarker(body);
  if (!fault) return false;
  if (fault.endsWith('-once')) {
    const marker = fault;
    if (seenTransientFaults.has(marker)) return false;
    seenTransientFaults.add(marker);
  }
  if (fault === 'timeout') {
    const delayMs = Math.min(30_000, Math.max(250, Number(process.env.ARGUS_E2E_FAULT_DELAY_MS || 2_000) || 2_000));
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return false;
  }
  const status = Number(fault.replace('-once', ''));
  json(res, status, {
    type: status === 429 ? 'rate_limit_error' : 'api_error',
    error: { type: status === 429 ? 'rate_limit_error' : 'provider_error', message: `Deterministic Argus E2E Anthropic fault ${status}` },
  }, status === 429 ? { 'retry-after': '1' } : {});
  return true;
}

function completion(body) {
  return {
    id: 'msg-argus-e2e',
    type: 'message',
    role: 'assistant',
    model: body.model || 'e2e-claude',
    content: [{ type: 'text', text: 'ARGUS_E2E_ANTHROPIC_OK' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
  };
}

function streamCompletion(res, body) {
  const result = completion(body);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write('message_start', {
    type: 'message_start',
    message: { id: result.id, type: 'message', role: 'assistant', model: result.model, usage: { input_tokens: 12 } },
  });
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.content[0].text } });
  write('content_block_stop', { type: 'content_block_stop', index: 0 });
  write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  write('message_stop', { type: 'message_stop' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return json(res, 200, { data: [{ id: 'e2e-claude', type: 'model' }] });
    }
    if (req.method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
      const body = await readJson(req);
      if (await respondFault(res, body)) return;
      if (body.stream) return streamCompletion(res, body);
      return json(res, 200, completion(body));
    }
    return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Unknown E2E fixture route: ${req.method} ${path}` } });
  } catch (error) {
    return json(res, 500, { type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`Argus E2E Anthropic fixture listening on ${port}\n`));
