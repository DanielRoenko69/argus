import { codegenHash, parseCodegenAuthority, parseCodegenRequest, validateCodegenReceipt, type CodegenDecision, type CodegenReceipt } from './codeGenerationContract.js';
import { runtimeHttpOptions } from './runtimeHttp.js';
import { CodegenExecutionError, parseCodegenFailure } from './codeGenerationContract.js';
import { registerWorkflowStop, assertWorkflowNotCanceled } from './workflowCancellation.js';
import { parseFileScope } from './developmentContract.js';
import type { QaState } from './qaAcceptance.js';
import { INSTALLER_GUIDANCE } from './installerGuidance.js';
import { usesGeneralStack, stackExecutionMode } from './stackClient.js';
export type CodegenState = QaState & { code_generation_policy_version?: number; code_generation_decision?: CodegenDecision | null; code_generation_receipt?: CodegenReceipt | null };
export const usesCodeGeneration = (s: CodegenState) => s.code_generation_policy_version === 1 && usesGeneralStack(s);
export function codegenFailureMessage(code: string): string {
  if (code === 'codegen_stack_session_capacity') return '[' + code + '] All retained workspace slots are occupied. '
    + 'The controller rejected this request before starting a generator. An operator must retire an eligible stopped workspace '
    + 'or raise ARGUS_WORKSPACE_MAX_SESSIONS within available disk capacity. No automatic retry; tests and approvals remain required.';
  if (code === 'codegen_stack_session_capacity_config_invalid') return '[' + code + '] The workspace retention limit is invalid. '
    + 'An operator must configure ARGUS_WORKSPACE_MAX_SESSIONS as an integer from 1 to 32. No automatic retry; tests and approvals remain required.';
  return '[' + code + '] Isolated code generation could not be completed and verified. No host installation or automatic retry. '
    + 'Inspect the recorded generator evidence; tests and approvals remain required.';
}
export function codegenCoderContext(s: CodegenState): string {
  if (!usesCodeGeneration(s) || s.code_generation_decision?.status !== 'ready') return '';
  return '\nArgus will run the following already-planned repository generator AFTER your implementation, in a separate isolated toolchain. '
    + 'Modify the authoritative source inputs, not generated outputs. Do not run the generator or install its tools in this shared workspace. '
    + 'An unavailable generator here is not by itself a blocker: report implementation ready when the source changes are complete, explicitly noting generation is pending. '
    + 'Other genuine missing requirements or implementation errors remain blockers. Do not claim successful generation, builds or tests.\n'
    + JSON.stringify({ summary: s.code_generation_decision.plan.summary, outputs: s.code_generation_decision.plan.outputPaths, generate: s.code_generation_decision.plan.generate }) + '\n';
}
export async function generateCode(s: CodegenState, threadId: string, reviewerId: number, basisSha256: string, sourceSha256: string, fetchFn: typeof fetch = fetch) {
  if (!usesCodeGeneration(s) || s.code_generation_decision?.status !== 'ready' || !s.argus_execution_grant) throw Error('codegen_policy_required');
  assertWorkflowNotCanceled();
  const payload = JSON.parse(Buffer.from(s.argus_execution_grant.split('.')[1] ?? '', 'base64url').toString('utf8'));
  const authority = parseCodegenAuthority(payload.codeGeneration); // routing only; Core verifies the signature
  const input = parseCodegenRequest({ action: 'generate', baseCommitSha: s.base_commit_sha, basisSha256, sourceSha256, plan: s.code_generation_decision.plan, ...stackExecutionMode(s) }, parseFileScope(s.allowed_files ?? ''));
  parseCodegenRequest(input, authority.allowedPaths);
  if (payload.workspaceRoot !== s.workspace_dir || payload.rootTraceId !== threadId) throw Error('codegen_scope_changed');
  const url = ((process.env['ARGUS_URL'] || 'http://mcp-server:3000').replace(/\/$/, '')) + '/api/agents/' + reviewerId + '/code-generation';
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + s.argus_execution_grant, 'x-argus-root-trace-id': threadId };
  const unregister = registerWorkflowStop(async () => {
    const result = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify({ action: 'cancel', baseCommitSha: s.base_commit_sha, basisSha256 }), signal: AbortSignal.timeout(60000) });
    if (!result.ok || (await result.json() as { stopped?: boolean }).stopped !== true) throw Error('codegen_cancel_unconfirmed');
  });
  try {
    const response = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(input), ...runtimeHttpOptions(1800) });
    assertWorkflowNotCanceled();
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 128000) throw Error('codegen_receipt_limit');
    const value = JSON.parse(raw);
    if (!response.ok && value?.code === 'codegen_generation_failed_no_import' && value.failure) throw new CodegenExecutionError(parseCodegenFailure(value.failure));
    if (!response.ok) throw Error(typeof value?.code === 'string' && /^codegen_[a-z_]{1,80}$/.test(value.code) ? value.code : 'codegen_unavailable_no_replay');
    const receipt = validateCodegenReceipt(input, threadId, value);
    if (receipt.requestSha256 !== codegenHash({ ...input, threadId, workspaceRoot: s.workspace_dir, allowedPaths: authority.allowedPaths })) throw Error('codegen_request_changed');
    return receipt;
  } finally { unregister(); }
}
export function assertCodegenCurrent(s: CodegenState, basis: string, source: string) {
  if (!usesCodeGeneration(s)) return;
  if (!s.code_generation_decision) throw Error('codegen_plan_missing');
  if (s.code_generation_decision.status === 'not_needed') return;
  const r = s.code_generation_receipt;
  if (s.code_generation_decision.status !== 'ready' || !r || r.basisSha256 !== basis || r.resultSourceSha256 !== source
    || r.planSha256 !== codegenHash(s.code_generation_decision.plan) || r.executionMode !== stackExecutionMode(s).executionMode) throw Error('codegen_receipt_stale');
}
export const CODEGEN_PLAN_INSTRUCTION = "Inspect whether the requested implementation requires repository-owned code generation (API clients, schemas, bindings, etc.). You are the existing Reviewer, not a new agent. Read only; do not install or modify files. Consult the existing generator, manifests and locks, not guesses.\nReturn ONLY one JSON object:\n{\"version\":1,\"status\":\"not_needed\",\"summary\":\"evidence explaining why no generated artifacts are required\"}\nor {\"version\":1,\"status\":\"blocked\",\"summary\":\"specific unresolved generator/scope requirement\"}\nor {\"version\":1,\"status\":\"ready\",\"plan\":{\"version\":1,\"summary\":\"generator and manifest evidence\",\"setup\":\"complete bash setup script\",\"start\":\"offline service/environment setup or empty string\",\"generate\":\"repository-owned generator invocation\",\"outputPaths\":[\"exact/repo/relative/generated/file.ts\"]}}.\nThe generator runs after the Coder changes its source inputs. Enumerate every file that must be copied back, including intermediate schema files if the existing generator stores them in Git. Only 1-64 explicitly named UTF-8 text files, <=1 MiB each / 4 MiB total. No wildcards, deletions, binaries, hidden/config/credential/CI/build/dependency/agent-policy files. Do not expand the user's allowed paths. Never hand-author generated bytes or substitute tests.\nsetup runs in a new Ubuntu 24.04 container with bash/curl/git/unzip/Python/pytest, as container root without host mounts, socket or credentials. It may install any needed language runtime, uv, Bun/Node, generator and project dependencies using the existing manifest/lock and official HTTPS installers through the supplied allowlisted proxy. Writable HOME/cache paths exist ONLY there. No TLS/proxy bypass or widening destinations. setup must not change existing source files or lockfiles. Source snapshot at /repo excludes .git, hidden files, credentials and ignored dependencies. Do not assume packages are preinstalled; provision them in setup. Use documented disposable test configuration when an app must export its schema; never production secrets.\nAfter setup all processes stop and the proxy disconnects. start and generate then run OFFLINE in that same isolated container. Exports from setup do not persist; install tools in standard paths or export paths in start. Start disposable services locally only when required, redirect background output, wait for health. All existing source files except declared outputs must remain byte-identical. Use the repository's generator command directly if a wrapper additionally runs a broad mutating lint/formatter; do not edit the wrapper or change product requirements. Never modify tests/assertions, invoke CI, commit or push.\nLimits: setup 900 seconds, start+generation 600 seconds, 4 GiB RAM, 2 CPUs, 256 processes. Generation is not test success: project tests, independent QA, review and both human gates follow normally. If it cannot fit these boundaries, report blocked with concrete evidence." + INSTALLER_GUIDANCE;
