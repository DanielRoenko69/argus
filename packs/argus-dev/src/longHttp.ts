import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function boundedLongRequestTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(parsed)));
}

export interface LongJsonResponse {
  status: number;
  body: string;
}

/**
 * Node's built-in fetch may stop waiting for response headers after roughly
 * five minutes. Core agent turns can legitimately exceed that while their
 * durable runtime continues. Use an explicit socket timeout for this one
 * synchronous, long-running internal boundary.
 */
export function postLongRunningJson(
  urlValue: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs = boundedLongRequestTimeoutMs(process.env['ARGUS_AGENT_CHAT_TIMEOUT_MS']),
): Promise<LongJsonResponse> {
  const url = new URL(urlValue);
  const body = JSON.stringify(payload);
  const request = url.protocol === 'https:' ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': String(Buffer.byteLength(body)),
      },
    }, response => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`Argus agent response exceeds ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Argus agent request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end(body);
  });
}
