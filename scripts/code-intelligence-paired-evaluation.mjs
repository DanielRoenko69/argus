#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  evaluateCodeRetrievalPromotion,
  summarizeCodeRetrievalStrategy,
} from '../dist/codeIntelligence/evaluation.js';
import { createCodeQueryEmbedding } from '../dist/codeIntelligence/embeddings.js';
import { searchCodeIndex } from '../dist/codeIntelligence/retrieval.js';

dotenv.config();

if (!existsSync('/.dockerenv')) {
  try {
    const configured = new URL(process.env.OPENAI_BASE_URL ?? '');
    if (configured.hostname === 'litellm') {
      configured.hostname = '127.0.0.1';
      configured.port = process.env.LITELLM_PORT ?? configured.port ?? '4000';
      process.env.OPENAI_BASE_URL = configured.toString().replace(/\/$/u, '');
    }
  } catch {
    // The shared LLM client returns the actionable provider error if required.
  }
}

const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
const datasetPath = process.env.ARGUS_CODE_EVAL_DATASET
  ?? 'demo/code-intelligence/pino-multistream-string-level-evaluation.json';
const reportPath = process.env.ARGUS_CODE_EVAL_REPORT
  ?? 'test-results/code-intelligence-paired-evaluation.json';
const baselineSnapshotId = Number(process.env.ARGUS_CODE_EVAL_BASELINE_SNAPSHOT_ID ?? 0);
const candidateSnapshotId = Number(process.env.ARGUS_CODE_EVAL_CANDIDATE_SNAPSHOT_ID ?? 0);
const baselineStrategy = process.env.ARGUS_CODE_EVAL_BASELINE_STRATEGY ?? 'hybrid_graph';
const candidateStrategy = process.env.ARGUS_CODE_EVAL_CANDIDATE_STRATEGY ?? 'hybrid_graph';
const retrievalStrategies = new Set(['lexical', 'vector', 'hybrid', 'hybrid_graph']);

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
if (!Number.isSafeInteger(baselineSnapshotId) || baselineSnapshotId < 1) {
  throw new Error('ARGUS_CODE_EVAL_BASELINE_SNAPSHOT_ID is required');
}
if (!Number.isSafeInteger(candidateSnapshotId) || candidateSnapshotId < 1) {
  throw new Error('ARGUS_CODE_EVAL_CANDIDATE_SNAPSHOT_ID is required');
}
if (baselineSnapshotId === candidateSnapshotId) throw new Error('baseline and candidate snapshot IDs must differ');
if (!retrievalStrategies.has(baselineStrategy) || !retrievalStrategies.has(candidateStrategy)) {
  throw new Error('paired retrieval strategies must be lexical, vector, hybrid or hybrid_graph');
}

function boundedNumber(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const parsed = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateDataset(value) {
  if (!value || typeof value !== 'object' || value.schema !== 'argus.code-retrieval-evaluation.v1') {
    throw new Error('evaluation dataset schema must be argus.code-retrieval-evaluation.v1');
  }
  if (typeof value.repositoryKey !== 'string' || !value.repositoryKey.trim()) {
    throw new Error('evaluation repositoryKey is required');
  }
  if (!Array.isArray(value.cases) || value.cases.length < 3 || value.cases.length > 500) {
    throw new Error('paired evaluation dataset must contain 3-500 cases');
  }
  const ids = new Set();
  return {
    schema: value.schema,
    repositoryKey: value.repositoryKey.trim(),
    cases: value.cases.map((item, index) => {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      const query = typeof item?.query === 'string' ? item.query.trim() : '';
      const expectedFiles = Array.isArray(item?.expectedFiles)
        ? [...new Set(item.expectedFiles.filter(file => typeof file === 'string').map(file => file.trim()).filter(Boolean))]
        : [];
      const limit = Number(item?.limit ?? 5);
      if (!id || id.length > 128 || ids.has(id)) throw new Error(`case ${index} has an invalid or duplicate id`);
      if (!query || query.length > 2_000) throw new Error(`case '${id}' has an invalid query`);
      if (expectedFiles.length < 1 || expectedFiles.length > 32) throw new Error(`case '${id}' requires 1-32 expected files`);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error(`case '${id}' has an invalid limit`);
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

function assertComparable(baseline, candidate, repositoryKey) {
  for (const snapshot of [baseline, candidate]) {
    if (snapshot.repository_key !== repositoryKey) {
      throw new Error(`snapshot ${snapshot.id} repository '${snapshot.repository_key}' does not match dataset '${repositoryKey}'`);
    }
  }
  for (const field of ['repository_key', 'branch_name', 'commit_sha', 'provider', 'graph_schema_version', 'file_count', 'symbol_count', 'document_count']) {
    if (String(baseline[field]) !== String(candidate[field])) {
      throw new Error(`paired snapshots differ in immutable field '${field}'`);
    }
  }
  if (baseline.embedding_model) throw new Error('baseline snapshot must not contain an embedding model');
  if (!candidate.embedding_model) throw new Error('candidate snapshot must declare an embedding model');
}

const dataset = validateDataset(JSON.parse(await readFile(datasetPath, 'utf8')));
const policy = {
  minimumRecallAtK: boundedNumber('ARGUS_CODE_EVAL_MIN_RECALL', 0.75, 0, 1),
  maximumRecallDrop: boundedNumber('ARGUS_CODE_EVAL_MAX_RECALL_DROP', 0, 0, 1),
  maximumMrrDrop: boundedNumber('ARGUS_CODE_EVAL_MAX_MRR_DROP', 0.02, 0, 1),
  maximumUnexpectedFileRateIncrease: boundedNumber('ARGUS_CODE_EVAL_MAX_UNEXPECTED_FILE_RATE_INCREASE', 0, 0, 1),
  maximumLatencyRatio: boundedNumber('ARGUS_CODE_EVAL_MAX_LATENCY_RATIO', 2, 1, 100),
};
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
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
  if (!baseline || !candidate) throw new Error('both paired snapshots must exist and be ready');
  assertComparable(baseline, candidate, dataset.repositoryKey);

  const queryEmbeddings = new Map();
  for (const evaluationCase of dataset.cases) {
    queryEmbeddings.set(
      evaluationCase.id,
      await createCodeQueryEmbedding(candidate.embedding_model, evaluationCase.query),
    );
  }

  const conditions = [
    { label: 'baseline', snapshot: baseline, strategy: baselineStrategy, embedding: false },
    { label: 'candidate', snapshot: candidate, strategy: candidateStrategy, embedding: true },
  ];
  const observations = [];
  const evidence = [];
  for (const condition of conditions) {
    for (const evaluationCase of dataset.cases) {
      const startedAt = performance.now();
      const result = await searchCodeIndex(pool, {
        snapshotId: Number(condition.snapshot.id),
        query: evaluationCase.query,
        limit: evaluationCase.limit,
        strategy: condition.strategy,
        embedding: condition.embedding ? queryEmbeddings.get(evaluationCase.id) : null,
        allowedBundleIds: null,
      });
      const latencyMs = performance.now() - startedAt;
      observations.push({
        caseId: evaluationCase.id,
        strategy: condition.label,
        returnedFiles: result.evidence.map(item => item.filePath),
        latencyMs,
      });
      evidence.push({
        case_id: evaluationCase.id,
        variant: condition.label,
        snapshot_id: Number(condition.snapshot.id),
        retrieval_strategy: condition.strategy,
        latency_ms: latencyMs,
        results: result.evidence.map((item, rank) => ({
          rank: rank + 1,
          file_path: item.filePath,
          symbol_name: item.symbolName,
          channels: item.channels,
          fused_score: item.scores.fused,
        })),
      });
    }
  }

  const baselineSummary = summarizeCodeRetrievalStrategy('baseline', dataset.cases, observations);
  const candidateSummary = summarizeCodeRetrievalStrategy('candidate', dataset.cases, observations);
  const promotion = evaluateCodeRetrievalPromotion(baselineSummary, candidateSummary, policy);
  const report = {
    schema: 'argus.code-retrieval-paired-report.v2',
    generated_at: new Date().toISOString(),
    overall: promotion.status,
    source_free: true,
    dataset: { path: datasetPath, repository_key: dataset.repositoryKey, cases: dataset.cases.length },
    baseline: { snapshot: snapshotEvidence(baseline), strategy: baselineStrategy },
    candidate: { snapshot: snapshotEvidence(candidate), strategy: candidateStrategy },
    summaries: [baselineSummary, candidateSummary],
    deltas: {
      recall_at_k: candidateSummary.meanRecallAtK - baselineSummary.meanRecallAtK,
      mrr: candidateSummary.meanReciprocalRank - baselineSummary.meanReciprocalRank,
      top1: candidateSummary.top1Accuracy - baselineSummary.top1Accuracy,
      unexpected_file_rate: candidateSummary.meanUnexpectedFileRate - baselineSummary.meanUnexpectedFileRate,
      average_latency_ms: candidateSummary.averageLatencyMs - baselineSummary.averageLatencyMs,
    },
    promotion,
    evidence,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    overall: report.overall,
    report: reportPath,
    repository_key: dataset.repositoryKey,
    commit_sha: baseline.commit_sha,
    baseline_snapshot_id: baselineSnapshotId,
    candidate_snapshot_id: candidateSnapshotId,
    summaries: report.summaries.map(({ caseScores, ...summary }) => summary),
    deltas: report.deltas,
    promotion,
  }, null, 2)}\n`);
  if (promotion.status === 'failed') process.exitCode = 2;
} finally {
  await pool.end();
}
