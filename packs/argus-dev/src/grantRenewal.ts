import { decodePackExecutionGrant } from './executionGrant.js';
import { assertWorkflowNotCanceled } from './workflowCancellation.js';

type GrantState = { argus_execution_grant: string };
type Config = { configurable?: { thread_id?: string; execution_run_id?: string } };
const payload = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
const authority = (c: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(c)
  .filter(([key]) => key !== 'iat' && key !== 'exp').sort(([a], [b]) => a.localeCompare(b))));

/** Core is the only issuer. The Pack's decode is a consistency check, never
 * authorization. No agent/provider request is replayed on a renewal failure. */
export async function freshDevGrant(token: string, threadId: string, runId: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const old = payload(token);
  if (!Number.isSafeInteger(old.exp) || old.rootTraceId !== threadId) throw new Error('Run grant provenance is invalid.');
  if (Number(old.exp) > Math.floor(Date.now() / 1000) + 600) return token;
  if (!runId) throw new Error('Grant renewal requires a running server-owned execution.');
  assertWorkflowNotCanceled();
  const response = await fetchFn(`${process.env.ARGUS_URL ?? 'http://localhost:3000'}/api/internal/dev-grants/renew`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', 'x-workspace-secret': process.env.WORKSPACE_SECRET ?? '' },
    body: JSON.stringify({ grant: token, threadId, runId }),
  });
  if (!response.ok) throw new Error(`Run grant renewal rejected (${response.status}); no agent was dispatched. Recheck current permissions and retry options.`);
  const result = await response.json() as { grant?: string };
  if (typeof result.grant !== 'string' || authority(payload(result.grant)) !== authority(old)) {
    throw new Error('Renewed grant changed execution authority; no agent was dispatched.');
  }
  decodePackExecutionGrant(result.grant, { packId: 'argus.dev', agentId: 'coding-orchestrator',
    messageId: String(old.messageId), rootTraceId: threadId });
  assertWorkflowNotCanceled();
  return result.grant;
}

/** Persist renewal with the node result, never updateState mid-interrupt (which
 * can skip a node). A failed node retains the old checkpoint; its same grant ID
 * is still revocable and renewable only while its durable run is active. */
export function withRenewableGrant<S extends GrantState, R extends object>(node: (state: S, config?: Config) => Promise<R>) {
  return async (state: S, config?: Config): Promise<R & Partial<GrantState>> => {
    if (process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED !== 'true' || !state.argus_execution_grant) return node(state, config);
    const grant = await freshDevGrant(state.argus_execution_grant, config?.configurable?.thread_id ?? '', config?.configurable?.execution_run_id ?? '');
    const result = await node({ ...state, argus_execution_grant: grant }, config);
    return { ...result, argus_execution_grant: grant };
  };
}
