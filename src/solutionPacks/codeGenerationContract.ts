/** Byte-identical in Core, Dev and Workspace. No caller-defined execution authority. */
import { createHash } from 'node:crypto';
export const codegenHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const codegenBytesHash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
export const CODEGEN_MAX_FILE = 1024 * 1024;
export const CODEGEN_MAX_TOTAL = 4 * 1024 * 1024;
export const CODEGEN_MAX_RESPONSE = 6 * 1024 * 1024;

export type CodegenFailure = { phase: 'setup' | 'generate'; status: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number; outputSha256: string };
export function parseCodegenFailure(value: unknown): CodegenFailure {
  keys(value, 'phase,status,exitCode,stdout,stderr,durationMs,outputSha256');
  if (!['setup', 'generate'].includes(value.phase) || !['failed', 'timeout', 'output_limit', 'canceled', 'interrupted', 'disk_limit'].includes(value.status)
    || !(value.exitCode === null || Number.isInteger(value.exitCode)) || !text(value.stdout, 32768, false) || !text(value.stderr, 32768, false)
    || Buffer.byteLength(value.stdout + value.stderr) > 32768 || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || value.outputSha256 !== codegenHash([value.stdout, value.stderr])) throw Error('codegen_failure_invalid');
  return value as CodegenFailure;
}
export class CodegenExecutionError extends Error {
  constructor(readonly failure: CodegenFailure) { super('codegen_generation_failed_no_import'); }
}
// Same protected development paths as repositoryScope.ts; contract-tested.
export const CODEGEN_PROTECTED_PATH = '(^|/)(\\.[^/]+|AGENTS\\.md|CLAUDE\\.md|GEMINI\\.md|Jenkinsfile[^/]*|Dockerfile[^/]*|docker-compose[^/]*|compose[^/]*\\.ya?ml|Makefile|setup\\.(py|cfg)|pyproject\\.toml|pytest\\.ini|tox\\.ini|conftest\\.py|requirements[^/]*|constraints[^/]*|package[^/]*\\.json|[^/]*lock[^/]*|pom\\.xml|build\\.gradle[^/]*|Cargo\\.toml|go\\.mod|[^/]*\\.(pem|key|p12|pfx))($|/)';
const protectedPath = new RegExp(CODEGEN_PROTECTED_PATH, 'i');
export const codegenPath = (p: unknown): p is string => typeof p === 'string' && p.length <= 240
  && /^[A-Za-z0-9_./-]+$/.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..')
  && !protectedPath.test(p) && !/(^|\/)(node_modules|secrets|__pycache__|graphify-out)(\/|$)/i.test(p);
export function codegenScope(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 64 || v.some(p => !codegenPath(p)) || new Set(v).size !== v.length)
    throw Error('codegen_scope_invalid');
  return [...v].sort();
}
export type CodegenPlan = { version: 1; summary: string; setup: string; start: string; generate: string; outputPaths: string[] };
export function parseCodegenAuthority(v: unknown): { version: 1; allowedPaths: string[] } {
  keys(v, 'version,allowedPaths');
  if (v.version !== 1) throw Error('codegen_scope_invalid');
  return { version: 1, allowedPaths: codegenScope(v.allowedPaths) };
}
export type CodegenDecision = { version: 1; status: 'not_needed' | 'blocked'; summary: string } | { version: 1; status: 'ready'; plan: CodegenPlan };
function keys(v: unknown, names: string): asserts v is Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== names.split(',').sort().join(','))
    throw Error('codegen_schema_invalid');
}
function text(v: unknown, bytes: number, nonempty = true): v is string {
  return typeof v === 'string' && Buffer.byteLength(v) <= bytes && !v.includes('\0') && (!nonempty || !!v.trim());
}
export function parseCodegenPlan(v: unknown, allowed: string[]): CodegenPlan {
  keys(v, 'version,summary,setup,start,generate,outputPaths');
  const outputs = codegenScope(v.outputPaths), scope = codegenScope(allowed);
  if (v.version !== 1 || !text(v.summary, 2000) || !text(v.setup, 24000) || !text(v.start, 24000, false)
    || !text(v.generate, 24000) || !outputs.length || outputs.some(p => scope.length && !scope.includes(p)))
    throw Error('codegen_plan_invalid');
  return { version: 1, summary: v.summary, setup: v.setup, start: v.start, generate: v.generate, outputPaths: outputs };
}
export function parseCodegenDecision(s: string, allowed: string[]): CodegenDecision {
  if (Buffer.byteLength(s) > 85000) throw Error('codegen_proposal_limit');
  const v = JSON.parse(s.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
  if (v?.status === 'ready') {
    keys(v, 'version,status,plan'); if (v.version !== 1) throw Error('codegen_schema_invalid');
    return { version: 1, status: 'ready', plan: parseCodegenPlan(v.plan, allowed) };
  }
  keys(v, 'version,status,summary');
  if (v.version !== 1 || !['not_needed', 'blocked'].includes(v.status) || !text(v.summary, 2000)) throw Error('codegen_schema_invalid');
  return v as CodegenDecision;
}
export type CodegenRequest = { action: 'generate'; baseCommitSha: string; basisSha256: string; sourceSha256: string; plan: CodegenPlan; executionMode?: 'workspace-session-v1' };
export const codegenDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parseCodegenRequest(v: unknown, allowed: string[]): CodegenRequest {
  const session = (v as Partial<CodegenRequest> | null)?.executionMode === 'workspace-session-v1';
  keys(v, 'action,baseCommitSha,basisSha256,sourceSha256,plan' + (session ? ',executionMode' : ''));
  if (v.action !== 'generate' || typeof v.baseCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(v.baseCommitSha) || !codegenDigest(v.basisSha256) || !codegenDigest(v.sourceSha256))
    throw Error('codegen_request_invalid');
  return { action: 'generate', baseCommitSha: v.baseCommitSha, basisSha256: v.basisSha256, sourceSha256: v.sourceSha256, plan: parseCodegenPlan(v.plan, allowed),
    ...(session ? { executionMode: 'workspace-session-v1' as const } : {}) };
}
export type CodegenFile = { path: string; beforeSha256: string | null; sha256: string; content: string };
export function parseCodegenCancel(v: unknown): { action: 'cancel'; baseCommitSha: string; basisSha256: string } {
  keys(v, 'action,baseCommitSha,basisSha256');
  if (v.action !== 'cancel' || typeof v.baseCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(v.baseCommitSha) || !codegenDigest(v.basisSha256)) throw Error('codegen_request_invalid');
  return { action: 'cancel', baseCommitSha: v.baseCommitSha, basisSha256: v.basisSha256 };
}
export function parseCodegenFiles(v: unknown, plan: CodegenPlan): CodegenFile[] {
  if (!Array.isArray(v) || v.length !== plan.outputPaths.length) throw Error('codegen_outputs_invalid');
  let size = 0;
  for (const f of v) {
    keys(f, 'path,beforeSha256,sha256,content');
    if (!plan.outputPaths.includes(f.path) || !codegenDigest(f.sha256) || !(f.beforeSha256 === null || codegenDigest(f.beforeSha256))
      || typeof f.content !== 'string' || f.content.length > CODEGEN_MAX_FILE * 1.34) throw Error('codegen_outputs_invalid');
    const data = Buffer.from(f.content, 'base64'); size += data.length;
    if (data.length > CODEGEN_MAX_FILE || size > CODEGEN_MAX_TOTAL || data.toString('base64') !== f.content
      || codegenBytesHash(data) !== f.sha256 || data.includes(0)) throw Error('codegen_outputs_invalid');
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  if (new Set(v.map(f => f.path)).size !== v.length) throw Error('codegen_outputs_invalid');
  return v as CodegenFile[];
}
export type CodegenReceipt = { version: 1; threadId: string; requestSha256: string; basisSha256: string; sourceSha256: string;
  resultSourceSha256: string; planSha256: string; brokerRequestSha256: string; baseImage: string; applied: true;
  outputs: Array<Omit<CodegenFile, 'content'>>; finishedAt: string; executionMode?: 'workspace-session-v1' };
export function validateCodegenReceipt(input: CodegenRequest, threadId: string, v: unknown): CodegenReceipt {
  keys(v, 'version,threadId,requestSha256,basisSha256,sourceSha256,resultSourceSha256,planSha256,brokerRequestSha256,baseImage,applied,outputs,finishedAt'
    + (input.executionMode ? ',executionMode' : ''));
  if (v.executionMode !== input.executionMode) throw Error('codegen_receipt_mode');
  if (v.version !== 1 || v.threadId !== threadId || v.basisSha256 !== input.basisSha256 || v.sourceSha256 !== input.sourceSha256
    || v.planSha256 !== codegenHash(input.plan) || v.applied !== true || !codegenDigest(v.requestSha256)
    || !codegenDigest(v.resultSourceSha256) || !codegenDigest(v.brokerRequestSha256) || !/^sha256:[a-f0-9]{64}$/.test(v.baseImage)
    || typeof v.finishedAt !== 'string' || !Number.isFinite(Date.parse(v.finishedAt))
    || !Array.isArray(v.outputs) || v.outputs.length !== input.plan.outputPaths.length) throw Error('codegen_receipt_invalid');
  for (const f of v.outputs) {
    keys(f, 'path,beforeSha256,sha256');
    if (!input.plan.outputPaths.includes(f.path) || !codegenDigest(f.sha256) || !(f.beforeSha256 === null || codegenDigest(f.beforeSha256))) throw Error('codegen_receipt_invalid');
  }
  if (new Set(v.outputs.map((f: { path: string }) => f.path)).size !== v.outputs.length) throw Error('codegen_receipt_invalid');
  return v as CodegenReceipt;
}
