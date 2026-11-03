import { expect, type APIRequestContext } from '@playwright/test';

export type McpEnvelope<T = unknown> = {
  jsonrpc: '2.0';
  id?: number;
  result?: T;
  error?: { code: number; message: string };
};

function parseMcpEnvelope<T>(text: string): McpEnvelope<T> {
  const direct = text.trim();
  if (direct.startsWith('{')) return JSON.parse(direct) as McpEnvelope<T>;
  const event = direct.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .find(line => line.startsWith('{'));
  if (!event) throw new Error(`MCP response did not contain a JSON-RPC envelope: ${text}`);
  return JSON.parse(event) as McpEnvelope<T>;
}

export async function openMcpClient(request: APIRequestContext, apiKey: string) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const initialize = await request.post('/mcp', {
    headers,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'argus-e2e-policy-client', version: '1.0.0' },
      },
    },
  });
  const initializeText = await initialize.text();
  expect(initialize.status(), initializeText).toBe(200);
  const sessionId = initialize.headers()['mcp-session-id'];
  expect(sessionId).toBeTruthy();
  expect(parseMcpEnvelope(initializeText).result).toBeTruthy();

  const initialized = await request.post('/mcp', {
    headers: { ...headers, 'mcp-session-id': sessionId! },
    data: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  expect([200, 202, 204]).toContain(initialized.status());

  let requestId = 2;
  return {
    sessionId: sessionId!,
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<McpEnvelope<T>> {
      const response = await request.post('/mcp', {
        headers: { ...headers, 'mcp-session-id': sessionId! },
        data: { jsonrpc: '2.0', id: requestId++, method, params },
      });
      const responseText = await response.text();
      expect(response.status(), responseText).toBe(200);
      return parseMcpEnvelope<T>(responseText);
    },
  };
}
