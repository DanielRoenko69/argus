import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertWorkflowNotCanceled } from './workflowCancellation.js';
import { environmentPlanSchema, environmentReceiptSchema, environmentRequirementsSchema } from './projectEnvironment.js';
import { runtimeHttpOptions } from './runtimeHttp.js';
import { usesGeneralStack, usesWorkspaceSession, stackExecutionMode, stackRequest, type StackState } from './stackClient.js';
import { stackEnvironmentSchema, stackHash, validateStackResult } from './stackEnvironment.js';
import { stackRepairEvidence } from './stackRepair.js';

export const qaHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2000);
const fileSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), content: z.string().min(1).max(16000),
  qaCaseIds: z.array(z.string().min(1).max(64)).min(1).max(32), expected: text, oracle: text }).strict();
const authorSchema = z.object({ version: z.literal(1), status: z.enum(['ready', 'blocked']), summary: text,
  blockers: z.array(text).max(12), files: z.array(fileSchema).max(12), environmentRequirements: environmentRequirementsSchema.optional() }).strict();
export type QaArtifact = z.infer<typeof authorSchema> & { basisSha256: string; authoredSourceSha256: string; traceId: string; environmentPlanSha256?: string };
const receiptSchema = z.object({ version: z.literal(1), threadId: z.string().uuid(), basisSha256: digest, sourceSha256: digest,
  testSha256: digest, requestSha256: digest, profile: z.enum(['python-bwrap-v1', 'stack-container-v1', 'workspace-session-v1']),
  status: z.enum(['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'preparation_failed']), exitCode: z.number().int().nullable(),
  environment: environmentReceiptSchema.optional(), executionStarted: z.boolean().optional(),
  stackEnvironment: stackEnvironmentSchema.optional(),
  missingModules: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/)).max(12).optional(),
  stdout: z.string().max(32768), stderr: z.string().max(32768), durationMs: z.number().nonnegative(),
  passed: z.boolean(), assertionFailed: z.boolean(), collected: z.number().int().min(0).max(256),
  nodes: z.array(z.string().max(512)).max(256), outputSha256: digest, finishedAt: z.string().datetime() }).strict();
export type QaReceipt = z.infer<typeof receiptSchema>;
export type QaState = StackState & { qa_acceptance_policy_version?: number; qa_environment_policy_version?: number; qa_artifact?: QaArtifact | null; qa_receipt?: QaReceipt | null;
  code_generation_policy_version?: number; code_generation_decision?: import('./codeGenerationContract.js').CodegenDecision | null; code_generation_receipt?: import('./codeGenerationContract.js').CodegenReceipt | null;
  code_generation_repair_policy_version?: number; code_generation_repair_count?: number;
  code_generation_needs_repair?: boolean; code_generation_repair_pending?: boolean;
  qa_environment_requirements?: z.infer<typeof environmentRequirementsSchema>; qa_environment_repair_count?: number;
  qa_history?: unknown[]; workspace_dir?: string; base_commit_sha?: string; description?: string; issue_snapshot?: unknown;
  qa_test_plan?: string; technical_decisions?: unknown[]; allowed_files?: string; repository_scope_policy?: string;
  operator_clarifications?: unknown; planning_handoff?: string; argus_execution_grant?: string };
export const usesQaAcceptance = (s: QaState) => s.qa_acceptance_policy_version === 1;
export function qaBasis(s: QaState) {
  const basis = [s.workspace_dir, s.base_commit_sha, s.description, s.issue_snapshot, s.qa_test_plan,
    s.technical_decisions, s.allowed_files, s.repository_scope_policy, s.operator_clarifications, s.planning_handoff];
  // Old receipts keep their exact digest and behavior.
  if (s.qa_environment_policy_version === 1) basis.push({ environmentPolicyVersion: 1 });
  if (usesGeneralStack(s)) basis.push({ environmentPolicyVersion: s.qa_environment_policy_version });
  return qaHash(basis);
}
export function parseQaArtifact(s: QaState, output: string, sourceSha256: string, traceId: string, environmentPlanSha256?: string): QaArtifact {
  if (Buffer.byteLength(output) > 100000) throw new Error('QA artifact too large');
  const parsed = authorSchema.parse(JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  digest.parse(sourceSha256); z.string().uuid().parse(traceId);
  const plan = JSON.parse(s.qa_test_plan || '{}') as { testCases?: Array<{ id: string }> };
  const ids = new Set(plan.testCases?.map(t => t.id) ?? []);
  if (!ids.size || new Set(parsed.files.map(f => f.id)).size !== parsed.files.length
    || Buffer.byteLength(JSON.stringify(parsed.files)) > 80000
    || Buffer.byteLength(JSON.stringify(parsed.files.map(({ id, content }) => ({ id, content })))) > 72000
    || parsed.files.some(f => !f.content.trim() || f.content.includes('\0') || Buffer.byteLength(f.content) > 16000
      || new Set(f.qaCaseIds).size !== f.qaCaseIds.length || f.qaCaseIds.some(id => !ids.has(id)))
    || (parsed.status === 'ready' && (!parsed.files.length || parsed.blockers.length))
    || (parsed.status === 'blocked' && !parsed.blockers.length)) throw new Error('Invalid QA artifact or case references');
  if (s.qa_environment_policy_version === 1 || usesGeneralStack(s)) digest.parse(environmentPlanSha256);
  else if (environmentPlanSha256 !== undefined || parsed.environmentRequirements !== undefined) throw new Error('Unexpected environment policy');
  return { ...parsed, basisSha256: qaBasis(s), authoredSourceSha256: sourceSha256, traceId,
    ...(environmentPlanSha256 ? { environmentPlanSha256 } : {}) };
}
export function qaFiles(artifact: QaArtifact) { return artifact.files.map(({ id, content }) => ({ id, content })); }
export function validateQaReceipt(s: QaState, threadId: string, sourceSha256: string, raw: unknown): QaReceipt {
  const r = receiptSchema.parse(raw), a = s.qa_artifact;
  if (usesGeneralStack(s)) {
    if (!a || a.status !== 'ready' || a.basisSha256 !== qaBasis(s) || !s.stack_plan || !s.stack_result?.passed
      || s.stack_result.sourceSha256 !== sourceSha256 || a.environmentPlanSha256 !== stackHash(s.stack_plan)
      || !(usesWorkspaceSession(s) ? s.stack_result.stackEnvironment.preparedSession : s.stack_result.stackEnvironment.preparedImage)
      || r.environment !== undefined
      || (usesWorkspaceSession(s) && stackHash(r.stackEnvironment?.workspaceDatabase ?? null)
        !== stackHash(s.stack_result.stackEnvironment.workspaceDatabase ?? null))) throw new Error('QA stack evidence binding failed');
    return validateStackResult({ action: 'run', baseCommitSha: s.base_commit_sha!, basisSha256: a.basisSha256,
      sourceSha256, stackPlan: s.stack_plan, files: qaFiles(a), ...stackExecutionMode(s), ...(usesWorkspaceSession(s)
        ? { preparedSession: s.stack_result.stackEnvironment.preparedSession! } : { preparedImage: s.stack_result.stackEnvironment.preparedImage! }) }, threadId, raw);
  }
  if (r.profile !== 'python-bwrap-v1' || r.stackEnvironment !== undefined) throw new Error('QA profile mismatch');
  if (!a || a.status !== 'ready' || a.basisSha256 !== qaBasis(s) || r.threadId !== threadId
    || r.basisSha256 !== a.basisSha256 || r.sourceSha256 !== sourceSha256 || r.testSha256 !== qaHash(qaFiles(a))
    || r.outputSha256 !== qaHash([r.stdout, r.stderr]) || r.nodes.length !== r.collected
    || new Set(r.nodes).size !== r.nodes.length
    || (r.passed && (r.status !== 'completed' || r.exitCode !== 0 || !r.collected || r.assertionFailed || r.missingModules?.length))
    || (r.assertionFailed && (r.status !== 'failed' || r.exitCode !== 1 || r.missingModules?.length))
    || (s.qa_environment_policy_version === 1 ? !r.environment || r.environment.plan.planSha256 !== a.environmentPlanSha256
      || r.executionStarted !== (r.environment.status === 'ready')
      || (r.environment.status === 'blocked' && (r.status !== 'preparation_failed' || r.passed || r.assertionFailed || r.collected !== 0 || r.exitCode !== null))
      || (r.environment.status === 'ready' && r.status === 'preparation_failed')
      : r.environment !== undefined || r.executionStarted !== undefined || r.status === 'preparation_failed')) throw new Error('QA evidence binding failed');
  return r;
}
export async function qaRequest(s: QaState, threadId: string, reviewerId: number, action: 'inspect' | 'run', sourceSha256?: string, fetchFn: typeof fetch = fetch) {
  assertWorkflowNotCanceled();
  if (!usesQaAcceptance(s) || !s.argus_execution_grant) throw new Error('QA policy and workspace grant required');
  if (usesGeneralStack(s)) {
    const result = await stackRequest(s, threadId, reviewerId, qaBasis(s), action, sourceSha256, action === 'run' ? qaFiles(s.qa_artifact!) : undefined, fetchFn);
    return action === 'run' ? validateQaReceipt(s, threadId, sourceSha256!, result) : { ...result, environment: undefined };
  }
  const input = { action, baseCommitSha: s.base_commit_sha, basisSha256: qaBasis(s),
    ...(s.qa_environment_policy_version === 1 ? { environmentPolicyVersion: 1,
      ...(s.qa_environment_requirements?.length ? { environmentRequirements: s.qa_environment_requirements } : {}) } : {}),
    ...(action === 'run' ? { sourceSha256, files: qaFiles(s.qa_artifact!),
      ...(s.qa_environment_policy_version === 1 ? { environmentPlanSha256: s.qa_artifact!.environmentPlanSha256 } : {}) } : {}) };
  const response = await fetchFn(`${(process.env['ARGUS_URL'] || 'http://mcp-server:3000').replace(/\/$/, '')}/api/agents/${reviewerId}/qa-tests`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.argus_execution_grant}`, 'x-argus-root-trace-id': threadId },
    body: JSON.stringify(input), ...(s.qa_environment_policy_version === 1 ? runtimeHttpOptions(480) : { signal: AbortSignal.timeout(130000) }) });
  assertWorkflowNotCanceled();
  if (!response.ok) throw new Error('QA sandbox/evidence unavailable; no automatic replay');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 128000) throw new Error('QA evidence limit');
  if (action === 'run') return validateQaReceipt(s, threadId, sourceSha256!, JSON.parse(raw));
  const snapshot = z.object({ sourceSha256: digest, files: z.number(), excludedFiles: z.number(), python: z.boolean(), environment: environmentPlanSchema.optional() }).strict().parse(JSON.parse(raw));
  if ((s.qa_environment_policy_version === 1) !== Boolean(snapshot.environment)) throw new Error('Environment policy mismatch');
  return snapshot;
}
export async function assertQaCurrent(s: QaState, threadId: string, reviewerId: number) {
  if (!usesQaAcceptance(s)) return;
  const r = s.qa_receipt;
  if (!r?.passed) throw new Error('Independent QA has not passed');
  validateQaReceipt(s, threadId, r.sourceSha256, r);
  const current = await qaRequest(s, threadId, reviewerId, 'inspect');
  if (current.sourceSha256 !== r.sourceSha256) throw new Error('QA evidence is stale: workspace changed');
  if (s.qa_environment_policy_version === 1 && (!('python' in current) || current.environment?.planSha256 !== r.environment?.plan.planSha256)) {
    throw new Error('QA evidence is stale: environment changed');
  }
}
export function qaEvidence(s: QaState) {
  if (!usesQaAcceptance(s)) return null;
  return { policyVersion: 1, environmentPolicyVersion: s.qa_environment_policy_version ?? 0, artifact: s.qa_artifact ?? null, receipt: s.qa_receipt ?? null,
    environmentRequirements: s.qa_environment_requirements ?? [], environmentRepairs: s.qa_environment_repair_count ?? 0,
    ...(s.code_generation_policy_version === 1 ? { codeGeneration: { policyVersion: 1, decision: s.code_generation_decision, receipt: s.code_generation_receipt,
      repairPolicyVersion: s.code_generation_repair_policy_version ?? 0, repairs: s.code_generation_repair_count ?? 0,
      repairPending: s.code_generation_needs_repair === true || s.code_generation_repair_pending === true } } : {}),
    ...(usesGeneralStack(s) ? { stackPlan: s.stack_plan, stackResult: s.stack_result, stackRepairs: s.stack_repair_count,
      stackRepairPolicy: stackRepairEvidence(s) } : {}),
    history: s.qa_history ?? [], limitation: 'Independent supplemental Python tests; not complete coverage. External CI runs the repository suite separately.' };
}
export function mayRepairQaEnvironment(s: QaState) {
  const r = s.qa_receipt;
  return s.qa_environment_policy_version === 1 && (s.qa_environment_repair_count ?? 0) < 1
    && s.qa_artifact?.status === 'ready' && r?.status === 'failed' && !r.passed && !r.assertionFailed
    && r.environment?.status === 'ready' && r.environment.plan.profileId === 'python-public-wheels-v1'
    && Boolean(r.missingModules?.length);
}
export function parseEnvironmentRepair(s: QaState, output: string) {
  if (Buffer.byteLength(output) > 20000) throw new Error('Invalid environment repair');
  const proposal = z.object({ status: z.enum(['ready', 'blocked']), reason: text, requirements: environmentRequirementsSchema }).strict()
    .parse(JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  const previous = s.qa_environment_requirements ?? [];
  if (proposal.status === 'ready' && (proposal.requirements.length <= previous.length
    || previous.some(old => !proposal.requirements.some(p => p.requirement === old.requirement && p.reason === old.reason)))) throw new Error('Environment repair may only add requirements');
  return proposal;
}
export const QA_ENVIRONMENT_INSTRUCTION = `The project environment manager is enabled. Declared Python requirements are resolved automatically from PyPI as binary wheels, then installed offline into an isolated run-local environment. If your QA tests or the repository need an additional Python dependency, add optional environmentRequirements:[{"requirement":"PEP 508 distribution constraint","reason":"concrete source/import/test evidence and distribution mapping"}] to the JSON. This is a request under fixed policy, NOT install authority. No URLs, VCS, local packages, custom indexes, commands, OS packages or build hooks. No arbitrary package list is required from the user. Do not mark a known, ordinary missing wheel dependency blocked merely because it is not installed yet. Unknown mappings, external services, unsupported native builds, and changes to product behavior still require an explicit blocker. Everything else in the QA contract remains unchanged.`;
export const QA_ENVIRONMENT_REPAIR_INSTRUCTION = `You are diagnosing a missing Python dependency for the independent QA runner. Read source/manifest evidence only; do not edit or execute anything. The original QA test files and expectations are FROZEN and must remain byte-for-byte unchanged. Return ONLY {"status":"ready"|"blocked","reason":"source-backed explanation","requirements":[{"requirement":"PEP 508 distribution constraint","reason":"exact import/source evidence and known distribution mapping"}]}. Ready must ADD at least one justified dependency while preserving every prior entry exactly. The resolver preserves already-resolved versions and hashes. Public PyPI wheels only, no URLs, commands, VCS, source builds, OS packages, credentials or weakening tests. Do not guess an ambiguous import-to-distribution mapping or install the project itself from PyPI to mask missing local implementation; return blocked instead. This is the one allowed dependency-repair attempt, not permission to change the product or an approval.`;
export const QA_AUTHOR_INSTRUCTION = `You are the independent QA acceptance test author. Author additional executable Python/pytest tests for gaps and risky combinations in the original requirements and frozen QA test plan, NOT tests fitted to the Coder's output.
Read the implementation and test conventions, but do not edit or execute anything. Return source as JSON artifacts; Argus alone materializes them in an isolated temporary test directory. No product files, existing tests or configuration can be changed. Imports resolve the current repository /repo/src, /repo and installed dependencies. No network, subprocesses, threads, installs, repository writes, project conftest, plugin autoload or project pytest configuration. Scratch files only under /tmp. Limits: 12 files, 16 KB each, 72 KB total, 30 seconds wall time/20 CPU, 512 MiB. Use concrete assertions; no skips, xfail, fake successes, mocks of the behavior being tested or altered tolerances. Keep expected results independent and cite the oracle. A failed QA assertion is not automatically a correct product requirement.
Check the implementation against EVERY current technical decision and the original brief. If they conflict (including changed public shapes/signatures), report blocked with evidence; do not silently correct the plan or invent a new requirement. Missing prerequisites also mean blocked.
Return ONLY {"version":1,"status":"ready"|"blocked","summary":"bounded explanation and test limitations","blockers":[],"files":[{"id":"safe_lowercase_id","qaCaseIds":["existing exact QA case ID"],"expected":"concrete expectation","oracle":"independent requirement/source reference","content":"complete pytest module source"}]}. Ready requires at least one meaningful additional test file and no blockers. Blocked requires an actionable blocker. These artifacts are frozen across Coder retries; a wrong QA test stops for technical correction, never automatic weakening. This phase is not human approval.`;
