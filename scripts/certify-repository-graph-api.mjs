#!/usr/bin/env node
/**
 * Behavioral H4a certification against an explicitly disposable PostgreSQL DB.
 * Inserts a cyclic graph inside one transaction and always rolls it back.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { PostgresRepositoryGraphDataSource } from '../dist/codeIntelligence/repositoryGraphStore.js';
import { loadRepositoryFullGraph, loadRepositoryGraphNeighborhood } from '../dist/codeIntelligence/repositoryGraphService.js';
import { parseRepositoryGraphQuery } from '../dist/codeIntelligence/repositoryGraphValidation.js';

const { Client } = pg;
const databaseUrl = (process.env.REPOSITORY_GRAPH_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.REPOSITORY_GRAPH_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.REPOSITORY_GRAPH_CERTIFICATION_REPORT
  || 'test-results/repository-graph-certification.json';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function certify(client) {
  const suffix = randomBytes(5).toString('hex');
  await client.query('BEGIN');
  try {
    const bundle = (await client.query(
      `INSERT INTO mcp_service_bundles (name, label)
       VALUES ($1,$2) RETURNING id`,
      [`graph-cert-${suffix}`, `Graph certification ${suffix}`],
    )).rows[0];
    const snapshot = (await client.query(
      `INSERT INTO mcp_code_index_snapshots
         (repository_key, branch_name, commit_sha, provider, source_graph_digest,
          parser_version, graph_schema_version, status, file_count, symbol_count,
          edge_count, document_count, finished_at)
       VALUES ($1,'main',$2,'graphify',$3,'cert-parser','argus-graphify-v3',
               'ready',1,3,3,0,now()) RETURNING id`,
      [`certification/repo-${suffix}`, 'a'.repeat(40), 'b'.repeat(64)],
    )).rows[0];
    await client.query(
      `INSERT INTO mcp_code_index_snapshot_bundles (index_id, bundle_id) VALUES ($1,$2)`,
      [snapshot.id, bundle.id],
    );
    const file = (await client.query(
      `INSERT INTO mcp_code_index_files
         (index_id, path, language, content_hash, byte_size, line_count)
       VALUES ($1,'src/main.ts','typescript',$2,100,20) RETURNING id`,
      [snapshot.id, 'c'.repeat(64)],
    )).rows[0];
    const symbols = [];
    for (const [position, name] of ['alpha', 'beta', 'gamma'].entries()) {
      symbols.push((await client.query(
        `INSERT INTO mcp_code_index_symbols
           (index_id, file_id, name, qualified_name, kind, start_line, end_line)
         VALUES ($1,$2,$3,$4,'function',$5,$5) RETURNING id`,
        [snapshot.id, file.id, name, `src/main.ts#${name}`, position + 1],
      )).rows[0]);
    }
    for (const [source, target] of [[0, 1], [1, 0], [1, 1]]) {
      await client.query(
        `INSERT INTO mcp_code_index_edges
           (index_id, source_symbol_id, target_symbol_id, relation)
         VALUES ($1,$2,$3,'CALLS')`,
        [snapshot.id, symbols[source].id, symbols[target].id],
      );
    }

    const source = new PostgresRepositoryGraphDataSource(client);
    const exact = await loadRepositoryGraphNeighborhood(
      source,
      Number(snapshot.id),
      parseRepositoryGraphQuery({
        seed: `symbol:${symbols[0].id}`, direction: 'both', depth: '2', limit: '20',
      }),
      { allowedBundleIds: [Number(bundle.id)] },
    );
    assert(exact.snapshot.commitSha === 'a'.repeat(40), 'commit identity was not preserved');
    assert(exact.snapshot.graphDigest === `sha256:${'b'.repeat(64)}`, 'graph digest was not preserved');
    assert(exact.nodes.some(node => node.id === `file:${file.id}`), 'file declaration neighborhood is missing');
    assert(exact.edges.some(edge => edge.source === `symbol:${symbols[1].id}`
      && edge.target === `symbol:${symbols[1].id}`), 'self edge is missing');
    assert(new Set(exact.nodes.map(node => node.id)).size === exact.nodes.length, 'cycle duplicated graph nodes');

    const complete = await loadRepositoryFullGraph(
      source,
      Number(snapshot.id),
      { allowedBundleIds: [Number(bundle.id)] },
    );
    assert(complete.files.length === 1, 'complete graph did not return every file');
    assert(complete.symbols.length === 3, 'complete graph did not return every symbol');
    assert(complete.edges.length === 3, 'complete graph did not return every provider relationship');
    assert(complete.appliedLimits.returnedEdges === 6, 'complete graph did not count implicit declarations');
    assert(complete.relationTypes.length === 1 && complete.relationTypes[0] === 'calls', 'complete graph relation dictionary is invalid');
    assert(!complete.truncated, 'complete graph unexpectedly reported truncation');

    let unauthorizedHidden = false;
    try {
      await loadRepositoryGraphNeighborhood(
        source,
        Number(snapshot.id),
        parseRepositoryGraphQuery({ seed: `symbol:${symbols[0].id}` }),
        { allowedBundleIds: [Number(bundle.id) + 999] },
      );
    } catch (error) {
      unauthorizedHidden = error?.status === 404 && error?.message === 'repository snapshot not found';
    }
    assert(unauthorizedHidden, 'unauthorized snapshot identity was not hidden');

    await client.query('ROLLBACK');
    return {
      snapshot_authorization: true,
      immutable_identity: true,
      directed_cycle_and_self_edge: true,
      complete_graph: {
        nodes: complete.appliedLimits.returnedNodes,
        relations: complete.appliedLimits.returnedEdges,
        compact_relation_types: complete.relationTypes.length,
      },
      nodes: exact.nodes.length,
      edges: exact.edges.length,
      rolled_back: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    database: 'disposable database not configured',
  };
  if (databaseUrl) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      report.database = await certify(client);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.database = safeError(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed' || (required && report.status !== 'passed')) process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
