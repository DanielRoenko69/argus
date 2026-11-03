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

// Local bootstrap config points Core containers at the Docker DNS name. The
// evaluation CLI normally runs on the host, where LiteLLM is published on
// 127.0.0.1. Preserve explicit operator URLs and container execution.
if (!existsSync('/.dockerenv')) {
  try {
    const configured = new URL(process.env.OPENAI_BASE_URL ?? '');
    if (configured.hostname === 'litellm') {
      configured.hostname = '127.0.0.1';
      configured.port = process.env.LITELLM_PORT ?? configured.port ?? '4000';
      process.env.OPENAI_BASE_URL = configured.toString().replace(/\/$/, '');
    }
  } catch {
    // Target validation in the shared LLM client returns the actionable error.
  }
}

const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
const datasetPath = process.env.ARGUS_CODE_EVAL_DATASET ?? 'demo/code-intelligence/evaluation-cases.json';
const reportPath = process.env.ARGUS_CODE_EVAL_REPORT ?? 'test-results/code-intelligence-evaluation.json';
const configuredSnapshotId = Number(process.env.ARGUS_CODE_EVAL_SNAPSHOT_ID ?? 0);

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');

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
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 500) {
    throw new Error('evaluation dataset must contain 1-500 cases');
  }
  const ids = new Set();
  const cases = value.cases.map((item, index) => {
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
  });
  return { schema: value.schema, repositoryKey: value.repositoryKey.trim(), cases };
}

const dataset = validateDataset(JSON.parse(await readFile(datasetPath, 'utf8')));
const policy = {
  minimumRecallAtK: boundedNumber('ARGUS_CODE_EVAL_MIN_RECALL', 0.7, 0, 1),
  maximumRecallDrop: boundedNumber('ARGUS_CODE_EVAL_MAX_RECALL_DROP', 0, 0, 1),
  maximumMrrDrop: boundedNumber('ARGUS_CODE_EVAL_MAX_MRR_DROP', 0.05, 0, 1),
  maximumUnexpectedFileRateIncrease: boundedNumber('ARGUS_CODE_EVAL_MAX_UNEXPECTED_FILE_RATE_INCREASE', 0, 0, 1),
  maximumLatencyRatio: boundedNumber('ARGUS_CODE_EVAL_MAX_LATENCY_RATIO', 4, 1, 100),
};
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const selected = configuredSnapshotId > 0
    ? await pool.query(
      `SELECT id, repository_key, branch_name, commit_sha, provider, embedding_model
         FROM mcp_code_index_snapshots WHERE id=$1 AND status='ready' LIMIT 1`,
      [configuredSnapshotId],
    )
    : await pool.query(
      `SELECT id, repository_key, branch_name, commit_sha, provider, embedding_model
         FROM mcp_code_index_snapshots
        WHERE repository_key=$1 AND status='ready'
        ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`,
      [dataset.repositoryKey],
    );
  const snapshot = selected.rows[0];
  if (!snapshot) throw new Error('no ready code-index snapshot matched the evaluation dataset');
  if (snapshot.repository_key !== dataset.repositoryKey) {
    throw new Error(`snapshot repository '${snapshot.repository_key}' does not match dataset '${dataset.repositoryKey}'`);
  }
  const strategies = snapshot.embedding_model
    ? ['lexical', 'vector', 'hybrid', 'hybrid_graph']
    : ['lexical', 'hybrid', 'hybrid_graph'];
  const queryEmbeddings = new Map();
  if (snapshot.embedding_model) {
    for (const evaluationCase of dataset.cases) {
      queryEmbeddings.set(
        evaluationCase.id,
        await createCodeQueryEmbedding(snapshot.embedding_model, evaluationCase.query),
      );
    }
  }

  const observations = [];
  const evidence = [];
  for (const strategy of strategies) {
    for (const evaluationCase of dataset.cases) {
      const startedAt = performance.now();
      const result = await searchCodeIndex(pool, {
        snapshotId: Number(snapshot.id),
        query: evaluationCase.query,
        limit: evaluationCase.limit,
        strategy,
        embedding: strategy === 'lexical' ? null : (queryEmbeddings.get(evaluationCase.id) ?? null),
        allowedBundleIds: null,
      });
      const latencyMs = performance.now() - startedAt;
      observations.push({
        caseId: evaluationCase.id,
        strategy,
        returnedFiles: result.evidence.map(item => item.filePath),
        latencyMs,
      });
      evidence.push({
        case_id: evaluationCase.id,
        strategy,
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

  const summaries = strategies.map(strategy => summarizeCodeRetrievalStrategy(strategy, dataset.cases, observations));
  const hybrid = summaries.find(item => item.strategy === 'hybrid');
  const graph = summaries.find(item => item.strategy === 'hybrid_graph');
  const promotion = evaluateCodeRetrievalPromotion(hybrid, graph, policy);
  const report = {
    schema: 'argus.code-retrieval-evaluation-report.v2',
    generated_at: new Date().toISOString(),
    overall: promotion.status,
    source_free: true,
    dataset: { path: datasetPath, repository_key: dataset.repositoryKey, cases: dataset.cases.length },
    snapshot: {
      id: Number(snapshot.id), repository_key: snapshot.repository_key,
      branch_name: snapshot.branch_name, commit_sha: snapshot.commit_sha,
      provider: snapshot.provider, embedding_model: snapshot.embedding_model,
    },
    strategies: summaries.map(({ caseScores, ...summary }) => ({
      ...summary,
      case_scores: caseScores,
    })),
    promotion,
    evidence,
    next_gate: snapshot.embedding_model
      ? `Dense pgvector retrieval evaluated with ${snapshot.embedding_model}; expand the dataset and repository next.`
      : 'Snapshot has no embeddings; dense pgvector comparison remains explicitly unavailable.',
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    overall: report.overall,
    report: reportPath,
    repository_key: report.snapshot.repository_key,
    snapshot_id: report.snapshot.id,
    strategies: report.strategies.map(item => ({
      strategy: item.strategy,
      recall_at_k: item.meanRecallAtK,
      mrr: item.meanReciprocalRank,
      top1: item.top1Accuracy,
      unexpected_file_rate: item.meanUnexpectedFileRate,
      average_latency_ms: item.averageLatencyMs,
      p95_latency_ms: item.p95LatencyMs,
    })),
    promotion: report.promotion,
    next_gate: report.next_gate,
  }, null, 2)}\n`);
  if (promotion.status === 'failed') process.exitCode = 2;
} finally {
  await pool.end();
}
