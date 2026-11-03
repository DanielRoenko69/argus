// Minimal fetch wrapper for Argus API.
// Session cookie travels automatically (same origin).
// API-Key is also supported via X-API-Key header (set via localStorage for dev).

const DEV_API_KEY_LS_KEY = 'argus.devApiKey';

function buildHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const devKey = typeof localStorage !== 'undefined' ? localStorage.getItem(DEV_API_KEY_LS_KEY) : null;
  if (devKey) h['X-API-Key'] = devKey;
  return { ...h, ...(extra ?? {}) };
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let bodyData: unknown = null;
    try {
      bodyData = await res.json();
    } catch {
      bodyData = await res.text();
    }
    throw new ApiError(res.status, bodyData, `${method} ${path} → ${res.status}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
