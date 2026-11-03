import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertComparableSnapshots,
  formatEvidence,
  parseStructuredOutput,
  variantOrder,
} from './code-intelligence-stage2-evaluation.mjs';

test('Stage-2 parser accepts strict and fenced JSON but exports only scoring fields', () => {
  const strict = parseStructuredOutput(JSON.stringify({
    summary: 'diagnosis',
    likelyFiles: ['lib/multistream.js'],
    testBoundary: ['test/multistream.test.js'],
    citations: ['pino@abc:lib/multistream.js#L1-L10'],
  }));
  assert.equal(strict.parsed, true);
  assert.deepEqual(strict.likelyFiles, ['lib/multistream.js']);

  const fenced = parseStructuredOutput('```json\n{"likelyFiles":[],"testBoundary":[],"citations":[]}\n```');
  assert.equal(fenced.parsed, true);
  assert.equal(parseStructuredOutput('not json').parsed, false);
});

test('Stage-2 alternates blinded variant order', () => {
  assert.deepEqual(variantOrder(0), ['baseline', 'candidate']);
  assert.deepEqual(variantOrder(1), ['candidate', 'baseline']);
});

test('Stage-2 bounded evidence emits immutable exact citations', () => {
  const result = formatEvidence({
    evidence: [{
      repositoryKey: 'argus/pino',
      commitSha: 'a'.repeat(40),
      filePath: 'lib/multistream.js',
      startLine: 10,
      endLine: 20,
      qualifiedName: 'multistream',
      symbolName: 'multistream',
      channels: ['lexical', 'graph'],
      chunkKind: 'symbol',
      content: 'x'.repeat(20_000),
    }],
  }, 1_024);
  assert.equal(result.citations[0], `argus/pino@${'a'.repeat(40)}:lib/multistream.js#L10-L20`);
  assert.ok(result.bytes <= 1_024);
  assert.match(result.context, /\.\.\.\[truncated\]/u);
});

test('Stage-2 bounded evidence gives every ranked result a fair context slice', () => {
  const evidence = Array.from({ length: 5 }, (_, index) => ({
    repositoryKey: 'argus/pino',
    commitSha: 'a'.repeat(40),
    filePath: `lib/file-${index}.js`,
    startLine: 1,
    endLine: 100,
    qualifiedName: null,
    symbolName: null,
    channels: ['graph'],
    chunkKind: 'file',
    content: 'x'.repeat(20_000),
  }));
  const result = formatEvidence({ evidence }, 12_000);
  assert.deepEqual(result.files, evidence.map(item => item.filePath));
  assert.ok(result.bytes <= 12_000);
});

test('Stage-2 rejects snapshot pairs with changed corpus identity', () => {
  const baseline = {
    id: 1,
    repository_key: 'argus/pino',
    branch_name: 'main',
    commit_sha: 'a'.repeat(40),
    provider: 'graphify',
    graph_schema_version: '3',
    file_count: 10,
    symbol_count: 20,
    document_count: 30,
    embedding_model: null,
  };
  const candidate = { ...baseline, id: 2, embedding_model: 'argus-local-embedding' };
  assert.doesNotThrow(() => assertComparableSnapshots(baseline, candidate, 'argus/pino'));
  assert.throws(
    () => assertComparableSnapshots(baseline, { ...candidate, file_count: 11 }, 'argus/pino'),
    /immutable field 'file_count'/u,
  );
});

test('Stage-2 runner hard-codes the write-disabled execution mode', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('./code-intelligence-stage2-evaluation.mjs', import.meta.url),
    'utf8',
  ));
  assert.match(source, /executionMode: 'workspace-read-only'/u);
  assert.doesNotMatch(source, /executionMode: 'workspace'(?!-read-only)/u);
});
