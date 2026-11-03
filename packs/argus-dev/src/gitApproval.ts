import { decodePackExecutionGrant } from './executionGrant.js';

export function validateGitApproval(value: unknown, context: { threadId: string; checkpointId: string | null;
  stage: string; principal: unknown; bundleIds: unknown; workspaceRoot: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core approval authority is required.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'checkpointId,grant,messageId,stage'
    || typeof v.grant !== 'string' || typeof v.messageId !== 'string'
    || v.checkpointId !== context.checkpointId || v.stage !== context.stage
    || !['human_approval','human_approval_pr'].includes(context.stage)) throw new Error('Core approval checkpoint changed.');
  const grant = decodePackExecutionGrant(v.grant, { packId: 'argus.dev', agentId: 'coding-orchestrator',
    messageId: v.messageId, rootTraceId: context.threadId });
  if (`${grant.claims.principalKind}:${grant.claims.principalId}` !== context.principal
    || grant.claims.principalKind !== 'user' || grant.claims.workspaceRoot !== context.workspaceRoot
    || !Array.isArray(context.bundleIds)
    || JSON.stringify([...grant.claims.bundleIds].sort((a,b) => a-b)) !== JSON.stringify([...context.bundleIds].sort((a,b) => a-b))) {
    throw new Error('Approval renewal cannot change the original principal, workspace or Bundles.');
  }
  return grant;
}
