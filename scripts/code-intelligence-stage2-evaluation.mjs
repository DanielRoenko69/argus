#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  evaluateCodeContextDryRunPromotion,
  summarizeCodeContextDryRun,
} from '../dist/codeIntelligence/contextEvaluation.js';
import { createCodeQueryEmbedding } from '../dist/codeIntelligence/embeddings.js';
import { searchCodeIndex } from '../dist/codeIntelligence/retrieval.js';

dotenv.config();

const RETRIEVAL_STRATEGY = 'hybrid_graph';
const DEFAULT_CONTEXT_BYTES = 12_000;
const DEFAULT_TIMEOUT_SEC = 900;

function strings(value, maximumItems = 32, maximumLength = 1_000) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim().slice(0, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems);
}

/** Parse the deliberately strict JSON response while discarding free-form text. */
export function parseStructuredOutput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const candidates = [text, fenced].filter(Boolean);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!Array.isArray(value.likelyFiles) || !Array.isArray(value.testBoundary)
        || !Array.isArray(value.citations)) continue;
      return {
        parsed: true,
        likelyFiles: strings(value.likelyFiles),
        testBoundary: strings(value.testBoundary),
        citations: strings(value.citations),
        value,
      };
    } catch {
      // Try the next safe JSON candidate.
    }
  }
  return { parsed: false, likelyFiles: [], testBoundary: [], citations: [], value: null };
}

/** Alternate order so neither variant systematically benefits from a warm runtime cache. */
export function variantOrder(caseIndex) {
  return caseIndex % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
}

function truncateUtf8(value, maximumBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maximumBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maximumBytes - 18)).toString('utf8')}\n...[truncated]`;
}

function citationFor(item) {
  const start = Number.isSafeInteger(item.startLine) ? item.startLine : 1;
  const end = Number.isSafeInteger(item.endLine) && item.endLine >= start ? item.endLine : start;
  return `${item.repositoryKey}@${item.commitSha}:${item.filePath}#L${start}-L${end}`;
}

/** Build bounded prompt evidence. The returned report metadata never contains `context`. */
export function formatEvidence(searchResult, maximumBytes = DEFAULT_CONTEXT_BYTES) {
  const blocks = [];
  const citations = [];
  const files = [];
  let usedBytes = 0;
  const resultCount = Math.max(1, searchResult.evidence.length);
  const separatorBytes = Math.max(0, resultCount - 1) * 2;
  const perResultBytes = Math.floor((maximumBytes - separatorBytes) / resultCount);
  for (const item of searchResult.evidence) {
    const citation = citationFor(item);
    const header = [
      `<code_evidence citation="${citation}">`,
      `path: ${item.filePath}`,
      `symbol: ${item.qualifiedName ?? item.symbolName ?? 'file'}`,
      `channels: ${item.channels.join(', ')}`,
      `chunk: ${item.chunkKind}`,
    ].join('\n');
    const footer = '\n</code_evidence>';
    const fixedBytes = Buffer.byteLength(`${header}\n${footer}`, 'utf8');
    // Allocate a fair slice to every ranked result. A large file-level chunk
    // must not starve lower-ranked graph evidence from the bounded context.
    const remaining = perResultBytes - fixedBytes;
    if (remaining < 160) break;
    const content = truncateUtf8(item.content, remaining);
    const block = `${header}\n${content}${footer}`;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    const separator = blocks.length > 0 ? 2 : 0;
    if (usedBytes + separator + blockBytes > maximumBytes) break;
    blocks.push(block);
    citations.push(citation);
    files.push(item.filePath);
    usedBytes += separator + blockBytes;
    if (usedBytes >= maximumBytes) break;
  }
  return {
    context: blocks.join('\n\n'),
    citations,
    files,
    bytes: usedBytes,
  };
}

export function validateDataset(value) {
  if (!value || typeof value !== 'object' || value.schema !== 'argus.code-retrieval-evaluation.v1') {
    throw new Error('evaluation dataset schema must be argus.code-retrieval-evaluation.v1');
  }
  if (typeof value.repositoryKey !== 'string' || !value.repositoryKey.trim()) {
    throw new Error('evaluation repositoryKey is required');
  }
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 100) {
    throw new Error('Stage-2 evaluation dataset must contain 1-100 cases');
  }
  const ids = new Set();
  return {
    schema: value.schema,
    repositoryKey: value.repositoryKey.trim(),
    cases: value.cases.map((item, index) => {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      const query = typeof item?.query === 'string' ? item.query.trim() : '';
      const expectedFiles = strings(item?.expectedFiles, 32, 512);
      const limit = Number(item?.limit ?? 5);
      if (!id || ids.has(id) || id.length > 128) throw new Error(`case ${index} has an invalid or duplicate id`);
      if (!query || query.length > 2_000) throw new Error(`case '${id}' has an invalid query`);
      if (expectedFiles.length < 1) throw new Error(`case '${id}' requires expectedFiles`);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error(`case '${id}' has an invalid limit`);
      ids.add(id);
      return { id, query, expectedFiles, limit };
    }),
  };
}

function snapshotEvidence(row) {
  return {
    id: Number(row.id),
    repository_key: row.repository_key,
    branch_name: row.branch_name,
    commit_sha: row.commit_sha,
    provider: row.provider,
    graph_schema_version: row.graph_schema_version,
    embedding_model: row.embedding_model,
    file_count: Number(row.file_count),
    symbol_count: Number(row.symbol_count),
    document_count: Number(row.document_count),
  };
}

export function assertComparableSnapshots(baseline, candidate, repositoryKey) {
  for (const snapshot of [baseline, candidate]) {
    if (snapshot.repository_key !== repositoryKey) {
      throw new Error(`snapshot ${snapshot.id} does not match dataset repository '${repositoryKey}'`);
    }
  }
  for (const field of [
    'repository_key', 'branch_name', 'commit_sha', 'provider', 'graph_schema_version',
    'file_count', 'symbol_count', 'document_count',
  ]) {
    if (String(baseline[field]) !== String(candidate[field])) {
      throw new Error(`paired snapshots differ in immutable field '${field}'`);
    }
  }
  if (baseline.embedding_model) throw new Error('baseline snapshot must not contain an embedding model');
  if (!candidate.embedding_model) throw new Error('candidate snapshot must declare an embedding model');
}

function boundedNumber(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const parsed = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function positiveInteger(name, fallback, minimum, maximum) {
  const value = boundedNumber(name, fallback, minimum, maximum);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function parseCaseFilter(argv) {
  const index = argv.indexOf('--case');
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error('--case requires a case id');
  return value;
}

function hostLlmBaseUrl() {
  if (existsSync('/.dockerenv')) return;
  try {
    const configured = new URL(process.env.OPENAI_BASE_URL ?? '');
    if (configured.hostname === 'litellm') {
      configured.hostname = '127.0.0.1';
      configured.port = process.env.LITELLM_PORT ?? configured.port ?? '4000';
      process.env.OPENAI_BASE_URL = configured.toString().replace(/\/$/u, '');
    }
  } catch {
    // The embedding client returns the actionable configuration error.
  }
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    const detail = body?.error ?? text.slice(0, 500) ?? 'unknown error';
    throw new Error(`${label} HTTP ${response.status}: ${detail}`);
  }
  return body;
}

async function workspaceRequest(baseUrl, secret, path, body, timeoutMs) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-workspace-secret': secret,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return responseJson(response, `agent-workspace ${path}`);
}

async function workspaceFingerprint(baseUrl, secret, workspaceRoot) {
  const result = await workspaceRequest(baseUrl, secret, '/exec', {
    cmd: 'git rev-parse HEAD && git status --porcelain=v1 --untracked-files=all',
    cwd: workspaceRoot,
    timeoutSec: 30,
  }, 45_000);
  if (result.exit_code !== 0) {
    throw new Error(`workspace fingerprint failed: ${String(result.stderr ?? '').slice(0, 500)}`);
  }
  return String(result.stdout ?? '').replaceAll('\r\n', '\n').trimEnd();
}

async function resolveAgent(pool, name, taskType) {
  const selected = await pool.query(
    `SELECT a.id, a.name, a.system_prompt, p.id AS profile_id, p.name AS profile_name,
            p.runtime_type, p.enabled AS profile_enabled, p.model, p.reasoning_effort,
            p.allowed_task_types
       FROM mcp_agents a
       JOIN mcp_agent_runtime_profiles p ON p.id=a.runtime_profile_id
      WHERE lower(a.name)=lower($1) AND a.enabled=true
      LIMIT 1`,
    [name],
  );
  const agent = selected.rows[0];
  if (!agent) throw new Error(`enabled Agent '${name}' with a runtime profile was not found`);
  if (!agent.profile_enabled || agent.runtime_type !== 'codex') {
    throw new Error(`Agent '${name}' must use an enabled Codex runtime profile for Stage 2`);
  }
  if (!Array.isArray(agent.allowed_task_types) || !agent.allowed_task_types.includes(taskType)) {
    throw new Error(`Agent '${name}' runtime profile does not allow task '${taskType}'`);
  }
  return agent;
}

function runtimeEvidence(agent) {
  return {
    agent_id: Number(agent.id),
    agent_name: agent.name,
    profile_id: Number(agent.profile_id),
    profile_name: agent.profile_name,
    runtime_type: agent.runtime_type,
    model: agent.model ?? 'codex-default',
    reasoning_effort: agent.reasoning_effort ?? 'high',
  };
}

async function callCodex(baseUrl, secret, workspaceRoot, agent, taskType, prompt, timeoutSec) {
  const runId = randomUUID();
  const rootTraceId = randomUUID();
  const result = await workspaceRequest(baseUrl, secret, '/codex/run', {
    prompt,
    cwd: workspaceRoot,
    ...(agent.model ? { model: agent.model } : {}),
    reasoningEffort: agent.reasoning_effort ?? 'high',
    timeoutSec,
    runId,
    rootTraceId,
    agentId: Number(agent.id),
    taskType,
    executionMode: 'workspace-read-only',
  }, (timeoutSec + 30) * 1_000);
  return {
    ...result,
    runId: result.runId ?? runId,
    rootTraceId,
  };
}

function plannerPrompt(evaluationCase, agent, evidence) {
  return `You are participating in a blinded, write-disabled Argus.Dev context-quality evaluation.

Configured Agent policy:
<agent_policy>
${agent.system_prompt ?? ''}
</agent_policy>

Hard rules:
- Analyze only. Never edit files, run mutating commands, create branches, commit, or use network access.
- Ground repository claims only in <retrieved_code_context>.
- A citation is valid only when copied byte-for-byte from the supplied citation attributes.
- likelyFiles and testBoundary must contain repository-relative paths only.
- Return exactly one JSON object, with no Markdown fence and no prose outside JSON.

Ticket:
${evaluationCase.query}

<retrieved_code_context>
${evidence.context}
</retrieved_code_context>

Required JSON shape:
{
  "summary": "short diagnosis",
  "implementationPlan": ["ordered read-only plan step"],
  "likelyFiles": ["path/from/context"],
  "testBoundary": ["test/path/from/context"],
  "citations": ["exact supplied citation"],
  "uncertainties": ["missing evidence, if any"]
}`;
}

function knowledgePrompt(evaluationCase, agent, evidence, planner) {
  return `You are participating in a blinded, write-disabled Argus.Dev context-quality evaluation.

Configured Agent policy:
<agent_policy>
${agent.system_prompt ?? ''}
</agent_policy>

Hard rules:
- Analyze only. Never edit files, run mutating commands, create branches, commit, or use network access.
- Verify the plan only against <retrieved_code_context>; do not invent repository facts.
- A citation is valid only when copied byte-for-byte from the supplied citation attributes.
- likelyFiles and testBoundary must contain repository-relative paths only.
- Return exactly one JSON object, with no Markdown fence and no prose outside JSON.

Ticket:
${evaluationCase.query}

Planner result:
${JSON.stringify(planner ?? {})}

<retrieved_code_context>
${evidence.context}
</retrieved_code_context>

Required JSON shape:
{
  "patterns": ["relevant implementation pattern"],
  "relevantApis": ["relevant API or symbol"],
  "likelyFiles": ["path/from/context"],
  "testBoundary": ["test/path/from/context"],
  "citations": ["exact supplied citation"],
  "missingContext": ["missing evidence, if any"],
  "planAssessment": "short assessment"
}`;
}

function publicRunEvidence(result, parsed) {
  return {
    run_id: result.runId,
    root_trace_id: result.rootTraceId,
    thread_id: result.threadId ?? null,
    model: result.model,
    duration_ms: Number(result.durationMs ?? 0),
    usage: result.usage ?? null,
    output: {
      parsed: parsed.parsed,
      likely_files: parsed.likelyFiles,
      test_boundary: parsed.testBoundary,
      citations: parsed.citations,
    },
  };
}

async function runCondition(input) {
  const {
    pool, condition, evaluationCase, queryEmbedding, contextBytes, workspaceUrl,
    workspaceSecret, workspaceRoot, planner, knowledge, timeoutSec,
  } = input;
  const before = await workspaceFingerprint(workspaceUrl, workspaceSecret, workspaceRoot);
  const search = await searchCodeIndex(pool, {
    snapshotId: Number(condition.snapshot.id),
    query: evaluationCase.query,
    limit: evaluationCase.limit,
    strategy: RETRIEVAL_STRATEGY,
    embedding: condition.embedding ? queryEmbedding : null,
    allowedBundleIds: null,
  });
  const evidence = formatEvidence(search, contextBytes);
  const plannerInput = plannerPrompt(evaluationCase, planner, evidence);
  const plannerRun = await callCodex(
    workspaceUrl, workspaceSecret, workspaceRoot, planner, 'plan', plannerInput, timeoutSec,
  );
  const plannerOutput = parseStructuredOutput(plannerRun.response);
  const knowledgeInput = knowledgePrompt(
    evaluationCase, knowledge, evidence, plannerOutput.value ?? {},
  );
  const knowledgeRun = await callCodex(
    workspaceUrl, workspaceSecret, workspaceRoot, knowledge, 'knowledge', knowledgeInput, timeoutSec,
  );
  const knowledgeOutput = parseStructuredOutput(knowledgeRun.response);
  const after = await workspaceFingerprint(workspaceUrl, workspaceSecret, workspaceRoot);
  const inputTokens = Number(plannerRun.usage?.input_tokens ?? 0)
    + Number(knowledgeRun.usage?.input_tokens ?? 0);
  const outputTokens = Number(plannerRun.usage?.output_tokens ?? 0)
    + Number(knowledgeRun.usage?.output_tokens ?? 0);
  return {
    observation: {
      caseId: evaluationCase.id,
      variant: condition.label,
      suppliedCitations: evidence.citations,
      planner: plannerOutput,
      knowledge: knowledgeOutput,
      retrievalFiles: evidence.files,
      workspaceUnchanged: before === after,
      contextTokensEstimated: Math.ceil(
        (Buffer.byteLength(plannerInput, 'utf8') + Buffer.byteLength(knowledgeInput, 'utf8')) / 4,
      ),
      inputTokens,
      outputTokens,
      durationMs: Number(plannerRun.durationMs ?? 0) + Number(knowledgeRun.durationMs ?? 0),
    },
    report: {
      case_id: evaluationCase.id,
      variant: condition.label,
      snapshot_id: Number(condition.snapshot.id),
      retrieval: {
        strategy: RETRIEVAL_STRATEGY,
        result_files: evidence.files,
        citations: evidence.citations,
        bounded_context_bytes: evidence.bytes,
      },
      planner: publicRunEvidence(plannerRun, plannerOutput),
      knowledge: publicRunEvidence(knowledgeRun, knowledgeOutput),
      workspace_unchanged: before === after,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  hostLlmBaseUrl();
  const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
  const datasetPath = process.env.ARGUS_CODE_STAGE2_DATASET
    ?? 'demo/code-intelligence/pino-multistream-string-level-evaluation.json';
  const reportPath = process.env.ARGUS_CODE_STAGE2_REPORT
    ?? 'test-results/pino-code-context-stage2-evaluation.json';
  const baselineSnapshotId = Number(process.env.ARGUS_CODE_STAGE2_BASELINE_SNAPSHOT_ID ?? 0);
  const candidateSnapshotId = Number(process.env.ARGUS_CODE_STAGE2_CANDIDATE_SNAPSHOT_ID ?? 0);
  const workspacePort = process.env.ARGUS_CODE_STAGE2_WORKSPACE_PORT ?? '3001';
  const workspaceUrl = (process.env.ARGUS_CODE_STAGE2_WORKSPACE_URL
    ?? `http://127.0.0.1:${workspacePort}`).replace(/\/+$/u, '');
  const workspaceRoot = process.env.ARGUS_CODE_STAGE2_WORKSPACE_ROOT ?? '/workspace/PINO-RETRIEVAL-AB';
  const workspaceSecret = process.env.WORKSPACE_SECRET ?? '';
  const contextBytes = positiveInteger('ARGUS_CODE_STAGE2_CONTEXT_BYTES', DEFAULT_CONTEXT_BYTES, 1_024, 24_000);
  const timeoutSec = positiveInteger('ARGUS_CODE_STAGE2_TIMEOUT_SEC', DEFAULT_TIMEOUT_SEC, 30, 1_800);
  if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
  if (!workspaceSecret || workspaceSecret.length < 16) throw new Error('WORKSPACE_SECRET is required');
  if (!Number.isSafeInteger(baselineSnapshotId) || baselineSnapshotId < 1) {
    throw new Error('ARGUS_CODE_STAGE2_BASELINE_SNAPSHOT_ID is required');
  }
  if (!Number.isSafeInteger(candidateSnapshotId) || candidateSnapshotId < 1) {
    throw new Error('ARGUS_CODE_STAGE2_CANDIDATE_SNAPSHOT_ID is required');
  }
  if (baselineSnapshotId === candidateSnapshotId) throw new Error('Stage-2 snapshot IDs must differ');

  const dataset = validateDataset(JSON.parse(await readFile(datasetPath, 'utf8')));
  const caseFilter = parseCaseFilter(argv);
  const cases = caseFilter ? dataset.cases.filter(item => item.id === caseFilter) : dataset.cases;
  if (cases.length === 0) throw new Error(`Stage-2 case '${caseFilter}' was not found`);
  const policy = {
    minimumPlanFileRecall: boundedNumber('ARGUS_CODE_STAGE2_MIN_PLAN_RECALL', 0.75, 0, 1),
    minimumTestBoundaryRecall: boundedNumber('ARGUS_CODE_STAGE2_MIN_TEST_RECALL', 0.75, 0, 1),
    maximumPlanRecallDrop: boundedNumber('ARGUS_CODE_STAGE2_MAX_PLAN_RECALL_DROP', 0, 0, 1),
    maximumContextTokenRatio: boundedNumber('ARGUS_CODE_STAGE2_MAX_CONTEXT_RATIO', 1.5, 1, 10),
  };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const status = await workspaceRequest(workspaceUrl, workspaceSecret, '/codex/status', undefined, 30_000);
    if (!status.enabled || !status.authenticated) {
      throw new Error('Codex sidecar must be enabled and authenticated before Stage 2');
    }
    const selected = await pool.query(
      `SELECT id, repository_key, branch_name, commit_sha, provider, graph_schema_version,
              embedding_model, file_count, symbol_count, document_count
         FROM mcp_code_index_snapshots
        WHERE id=ANY($1::bigint[]) AND status='ready'`,
      [[baselineSnapshotId, candidateSnapshotId]],
    );
    const byId = new Map(selected.rows.map(row => [Number(row.id), row]));
    const baseline = byId.get(baselineSnapshotId);
    const candidate = byId.get(candidateSnapshotId);
    if (!baseline || !candidate) throw new Error('both Stage-2 snapshots must exist and be ready');
    assertComparableSnapshots(baseline, candidate, dataset.repositoryKey);

    const planner = await resolveAgent(pool, 'planner', 'plan');
    const knowledge = await resolveAgent(pool, 'knowledge', 'knowledge');
    const conditions = new Map([
      ['baseline', { label: 'baseline', snapshot: baseline, embedding: false }],
      ['candidate', { label: 'candidate', snapshot: candidate, embedding: true }],
    ]);
    const queryEmbeddings = new Map();
    for (const evaluationCase of cases) {
      queryEmbeddings.set(
        evaluationCase.id,
        await createCodeQueryEmbedding(candidate.embedding_model, evaluationCase.query),
      );
    }

    const observations = [];
    const runs = [];
    for (let index = 0; index < cases.length; index += 1) {
      const evaluationCase = cases[index];
      for (const label of variantOrder(index)) {
        process.stderr.write(`[stage2] ${evaluationCase.id}: ${label}\n`);
        const result = await runCondition({
          pool,
          condition: conditions.get(label),
          evaluationCase,
          queryEmbedding: queryEmbeddings.get(evaluationCase.id),
          contextBytes,
          workspaceUrl,
          workspaceSecret,
          workspaceRoot,
          planner,
          knowledge,
          timeoutSec,
        });
        observations.push(result.observation);
        runs.push(result.report);
      }
    }

    const baselineSummary = summarizeCodeContextDryRun('baseline', cases, observations);
    const candidateSummary = summarizeCodeContextDryRun('candidate', cases, observations);
    const promotion = evaluateCodeContextDryRunPromotion(baselineSummary, candidateSummary, policy);
    const report = {
      schema: 'argus.code-context-stage2-report.v1',
      generated_at: new Date().toISOString(),
      overall: promotion.status,
      source_free: true,
      contains_bounded_model_output: true,
      mode: 'planner_knowledge_dry_run',
      dataset: {
        path: datasetPath,
        repository_key: dataset.repositoryKey,
        selected_cases: cases.map(item => ({ id: item.id, expected_files: item.expectedFiles })),
      },
      controls: {
        execution_mode: 'workspace-read-only',
        workspace_root: workspaceRoot,
        alternating_variant_order: true,
        context_bytes: contextBytes,
        planner_runtime: runtimeEvidence(planner),
        knowledge_runtime: runtimeEvidence(knowledge),
      },
      baseline: { snapshot: snapshotEvidence(baseline), strategy: RETRIEVAL_STRATEGY },
      candidate: { snapshot: snapshotEvidence(candidate), strategy: RETRIEVAL_STRATEGY },
      summaries: [baselineSummary, candidateSummary],
      promotion,
      runs,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      schema: report.schema,
      overall: report.overall,
      report: reportPath,
      cases: cases.map(item => item.id),
      summaries: report.summaries.map(({ caseScores, ...summary }) => summary),
      promotion,
    }, null, 2)}\n`);
    if (promotion.status === 'failed') process.exitCode = 2;
    return report;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[code-context-stage2] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
