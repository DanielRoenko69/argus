export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function networkErrorMessage(error: unknown): string {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return 'Could not reach Argus. Check that the Argus server is running on http://localhost:3000 and open the chat through /chat.';
  }
  return error instanceof Error ? error.message : String(error);
}

export async function apiGet<T>(url: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new ApiError(0, networkErrorMessage(error));
  }
  if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => r.statusText));
  return r.json() as Promise<T>;
}
export async function apiSend<T>(url: string, method: 'POST'|'DELETE'|'PATCH', body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, networkErrorMessage(error));
  }
  if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => r.statusText));
  return r.json() as Promise<T>;
}
