import http from 'node:http';

const port = Number(process.env.PORT || 4000);
const embedding = Array.from({ length: 3072 }, (_, index) => index === 0 ? 1 : 0);
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
  if (Array.isArray(message?.content)) {
    return message.content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n');
  }
  return '';
}

function faultMarker(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const messageText = messages.map(contentOf).join('\n').toUpperCase();
  const inputText = Array.isArray(body?.input) ? body.input.join('\n') : String(body?.input ?? '');
  const text = `${messageText}\n${inputText.toUpperCase()}`;
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
    if (seenTransientFaults.has(fault)) return false;
    seenTransientFaults.add(fault);
  }
  if (fault === 'timeout') {
    const delayMs = Math.min(30_000, Math.max(250, Number(process.env.ARGUS_E2E_FAULT_DELAY_MS || 2_000) || 2_000));
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return false;
  }
  const status = Number(fault.replace('-once', ''));
  json(res, status, {
    error: {
      type: fault === '429' ? 'rate_limit_error' : 'provider_error',
      code: `argus_e2e_fault_${fault}`,
      message: `Deterministic Argus E2E provider fault ${fault}`,
    },
  }, fault === '429' ? { 'retry-after': '1' } : {});
  return true;
}

function scenario(messages) {
  const lastUserIndex = messages.map(message => message.role).lastIndexOf('user');
  const rawLastUser = contentOf(messages[lastUserIndex]);
  const lastUser = contentOf(messages[lastUserIndex]).toLowerCase();
  const afterUser = messages.slice(lastUserIndex + 1);
  const lastTool = [...afterUser].reverse().find(message => message.role === 'tool');
  const toolContent = contentOf(lastTool);
  const system = messages.filter(message => message.role === 'system').map(contentOf).join('\n');

  // Argus Dev coder worker: Core enforces workspace_ls -> workspace_read ->
  // workspace_write before a terminal structured outcome. Corrections are
  // appended as user turns, so match the original implementation prompt.
  const coderPrompt = messages.find(message => message.role === 'user'
    && (contentOf(message).includes('You are a software implementation agent.')
      || contentOf(message).includes('You are the implementation agent fixing a failed CI run.')));
  if (coderPrompt) {
    const promptText = contentOf(coderPrompt);
    const ciFix = promptText.includes('fixing a failed CI run');
    const workspaceDir = ciFix
      ? `/workspace/${/Branch: feature\/([A-Za-z0-9-]+)/.exec(promptText)?.[1] ?? 'untitled'}`
      : /Workspace directory: (\/workspace\/[^\s(]+)/.exec(promptText)?.[1] ?? '/workspace';
    const target = `${workspaceDir}/src/argus-e2e.ts`;
    const calls = messages.filter(message => message.role === 'assistant' && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0).length;
    if (calls === 0) return { tool: 'workspace_ls', arguments: { path: workspaceDir } };
    if (calls === 1) return { tool: 'workspace_read', arguments: { path: target } };
    if (calls === 2) return { tool: 'workspace_write', arguments: { path: target, content: 'ARGUS_E2E_LANGGRAPH_CHANGE\n' } };
    if (ciFix) return { content: 'Applied the deterministic fix to src/argus-e2e.ts.\nFIX_VERDICT: APPLIED' };
    return {
      content: JSON.stringify({
        version: 2,
        status: 'ready',
        summary: 'Updated src/argus-e2e.ts with the deterministic ARGUS_E2E_LANGGRAPH_CHANGE marker.',
        blockers: [],
      }),
    };
  }

  if (lastUser.includes('compliance-audit-auftrag')) {
    if (!lastTool) return { tool: 'e2e_fabric_fabric_status', arguments: {} };
    return {
      content: JSON.stringify([
        {
          article: 'Art. 21(a)',
          title: 'Evidence-backed service controls',
          verdict: 'passed',
          severity: 'high',
          evidence: `The governed MCP evidence probe completed successfully: ${toolContent.slice(0, 240)}`,
          code_pointers: [],
          remediation: 'Retain the assessment trace and review the evidence with the accountable owner.',
        },
        {
          article: 'Art. 21(b)',
          title: 'Human review boundary',
          verdict: 'warning',
          severity: 'critical',
          evidence: 'Automated evidence is available, but legal applicability and final acceptance require an accountable human reviewer.',
          code_pointers: [],
          remediation: 'Record the responsible reviewer and the final applicability decision in the evidence pack.',
        },
      ]),
    };
  }

  // Argus Dev development contract v2 (planner and other bounded agents):
  // a ready outcome without blockers.
  if (rawLastUser.includes('Return only JSON: {"version":2,"status":"ready"|"blocked"')) {
    return {
      content: JSON.stringify({
        version: 2,
        status: 'ready',
        summary: '1. Update src/argus-e2e.ts with the deterministic ARGUS_E2E_LANGGRAPH_CHANGE marker.\n2. Run the ticket-specific checks.',
        blockers: [],
      }),
    };
  }

  // Argus Dev structured code review.
  if (rawLastUser.includes('{"verdict":"APPROVE|REQUEST_CHANGES"')) {
    return {
      content: JSON.stringify({
        verdict: 'APPROVE',
        summary: 'The deterministic implementation matches the plan and the ticket-specific tests pass. No release-blocking concerns were found.',
        findings: [{ severity: 'info', message: 'Deterministic LangGraph E2E change reviewed successfully.', file: 'src/argus-e2e.ts', line: 1 }],
        required_changes: [],
      }),
    };
  }

  if (lastUser.includes('test_verdict: pass') && lastUser.includes('test_verdict: fail')) {
    return { content: 'Ticket-specific deterministic checks completed.\nTEST_VERDICT: PASS' };
  }

  if (lastUser.includes('verdict: approved') && lastUser.includes('verdict: rejected')) {
    return {
      content: 'The deterministic implementation matches the plan and the ticket-specific tests pass. No release-blocking concerns were found.\n\n<annotations>\n[{"path":"src/argus-e2e.ts","severity":"info","comment":"Deterministic LangGraph E2E change reviewed successfully."}]\n</annotations>\n\nVERDICT: APPROVED',
    };
  }

  if (lastUser.includes('read-only ci failure diagnosis agent')) {
    return {
      content: 'The failed provider run is caused by a deterministic fixture assertion. The smallest safe fix is to update the scoped source file and rerun the local test command; no unrelated files need to change.',
    };
  }

  if (lastUser.includes('validate the proposed ci recovery')) {
    return { content: 'Recovery test command completed successfully.\nTEST_VERDICT: PASS' };
  }

  // The coding worker is intentionally exercised through the real workspace
  // tool loop.  Keep this fixture deterministic while still requiring the
  // same grounding sequence as a production coder: list, read, then write.
  // Depending on whether the workflow is using the regular runner or a
  // resumed checkpoint, the coder instruction can be present in the latest
  // user turn, the system envelope, or an earlier user message. Scan the
  // complete conversation so the deterministic fixture follows the same
  // workspace tool contract after a restart as it does on a fresh run.
  const allText = messages.map(contentOf).join('\n').toLowerCase();
  const isCodingWorker = allText.includes('software implementation agent')
    || allText.includes('software implementation specialist');
  const isCiRecoveryWorker = allText.includes('implementation agent fixing a failed ci run');
  if (isCodingWorker || isCiRecoveryWorker) {
    const conversationText = messages.map(contentOf).join('\n');
    const workspaceMatch = /Workspace directory:\s*(\/workspace\/[A-Za-z0-9-]+)/i.exec(conversationText)
      ?? /\/workspace\/([A-Za-z0-9-]+)/i.exec(conversationText);
    const workspace = workspaceMatch
      ? (workspaceMatch[1].startsWith('/workspace/') ? workspaceMatch[1] : `/workspace/${workspaceMatch[1]}`)
      : '/workspace/ARGUS-E2E-LG-1';
    const target = `${workspace}/src/argus-e2e.ts`;
    if (!lastTool) return { tool: 'workspace_ls', arguments: { path: workspace } };
    if (toolContent.includes('ARGUS_E2E_WORKSPACE_LIST')) {
      return { tool: 'workspace_read', arguments: { path: target } };
    }
    if (toolContent.includes('ARGUS_E2E_FILE_CONTENT')) {
      return {
        tool: 'workspace_write',
        arguments: { path: target, content: 'ARGUS_E2E_LANGGRAPH_CHANGE\n' },
      };
    }
    if (toolContent.includes('Wrote ')) {
      return isCiRecoveryWorker
        ? { content: 'Applied the minimal scoped fix.\nFIX_VERDICT: APPLIED' }
        : { content: '- src/argus-e2e.ts' };
    }
    return { tool: 'workspace_write', arguments: { path: target, content: 'ARGUS_E2E_LANGGRAPH_CHANGE\n' } };
  }

  if (lastUser.includes('prometheus bundle capability')) {
    if (!lastTool) {
      return {
        tool: 'e2e_prometheus_query',
        arguments: {
          query: lastUser.includes('after restart') ? 'argus_bundle_restart' : 'argus_bundle_agent',
          time: '2026-08-02T12:15:00Z',
        },
      };
    }
    return {
      content: toolContent.includes('ARGUS_E2E_PROMETHEUS_OK')
        ? 'ARGUS_E2E_BUNDLE_ALLOWED'
        : 'ARGUS_E2E_BUNDLE_ALLOWED_FAILED',
    };
  }

  if (lastUser.includes('bundle-external status capability')) {
    if (!lastTool) return { tool: 'e2e_fabric_fabric_status', arguments: {} };
    return {
      content: toolContent.includes('not available to this agent')
        ? 'ARGUS_E2E_BUNDLE_DENIED'
        : 'ARGUS_E2E_BUNDLE_BYPASS',
    };
  }

  if (lastUser.includes('prometheus range capability')) {
    if (!lastTool) {
      return {
        tool: 'e2e_prometheus_query_range',
        arguments: {
          query: 'argus_principal_boundary',
          start: '2026-08-02T12:00:00Z',
          end: '2026-08-02T12:15:00Z',
          step: '1m',
        },
      };
    }
    const denied = /not available to this agent|user-deny|group-deny|API-Key.*nicht erlaubt/i.test(toolContent);
    return {
      content: denied
        ? 'ARGUS_E2E_PRINCIPAL_DENIED'
        : toolContent.includes('ARGUS_E2E_PROMETHEUS_RANGE_OK')
          ? 'ARGUS_E2E_PRINCIPAL_BYPASS'
          : 'ARGUS_E2E_PRINCIPAL_DENY_FAILED',
    };
  }

  if (lastUser.includes('governed write')) {
    if (!lastTool) {
      return { tool: 'jira_create_issue', arguments: { summary: 'ARGUS E2E governed change' } };
    }
    if (/human approval|approval.*required|requires human/i.test(toolContent)) {
      return { content: 'ARGUS_E2E_APPROVAL_PENDING' };
    }
    return { content: 'ARGUS_E2E_APPROVAL_EXECUTED' };
  }

  if (lastUser.includes('remote mcp')) {
    if (!lastTool) return { tool: 'e2e_fabric_fabric_status', arguments: {} };
    return { content: toolContent.includes('ARGUS_E2E_MCP_FIXTURE_OK') ? 'ARGUS_E2E_MCP_OK' : 'ARGUS_E2E_MCP_FAILED' };
  }

  if (system.includes('ARGUS_KNOWLEDGE_SECRET_42')) {
    return { content: 'ARGUS_E2E_RAG_FOUND' };
  }

  return { content: 'ARGUS_E2E_CHAT_OK' };
}

function streamCompletion(res, result) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const write = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  write({ id: 'chatcmpl-argus-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-chat', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  if (result.tool) {
    write({
      id: 'chatcmpl-argus-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-chat',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_argus_e2e', type: 'function', function: { name: result.tool, arguments: JSON.stringify(result.arguments) } }] },
        finish_reason: null,
      }],
    });
    write({ id: 'chatcmpl-argus-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-chat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
  } else {
    write({ id: 'chatcmpl-argus-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-chat', choices: [{ index: 0, delta: { content: result.content }, finish_reason: null }] });
    write({ id: 'chatcmpl-argus-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
  }
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return json(res, 200, { object: 'list', data: [{ id: 'e2e-chat', object: 'model', owned_by: 'argus-e2e' }, { id: 'e2e-embedding', object: 'model', owned_by: 'argus-e2e' }] });
    }
    if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
      const body = await readJson(req);
      if (await respondFault(res, body)) return;
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return json(res, 200, {
        object: 'list',
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding })),
        model: body.model || 'e2e-embedding',
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      const body = await readJson(req);
      if (await respondFault(res, body)) return;
      if (body.stream) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        return streamCompletion(res, scenario(messages));
      }
      return json(res, 200, {
        id: 'chatcmpl-argus-e2e', object: 'chat.completion', created: 1, model: body.model || 'e2e-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    return json(res, 404, { error: { message: `Unknown E2E fixture route: ${req.method} ${path}` } });
  } catch (error) {
    return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`Argus E2E OpenAI fixture listening on ${port}\n`));
