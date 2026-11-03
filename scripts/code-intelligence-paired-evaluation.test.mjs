import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./code-intelligence-paired-evaluation.mjs', import.meta.url), 'utf8');
const dataset = JSON.parse(await readFile(
  new URL('../demo/code-intelligence/pino-multistream-string-level-evaluation.json', import.meta.url),
  'utf8',
));

test('paired evaluator binds both variants to one immutable repository state', () => {
  assert.match(source, /baseline and candidate snapshot IDs must differ/);
  assert.match(source, /paired snapshots differ in immutable field/);
  assert.match(source, /baseline snapshot must not contain an embedding model/);
  assert.match(source, /candidate snapshot must declare an embedding model/);
  assert.match(source, /maximumRecallDrop.*0/);
  assert.match(source, /maximumLatencyRatio.*2/);
});

test('Pino pilot freezes three query formulations before the A\/B run', () => {
  assert.equal(dataset.schema, 'argus.code-retrieval-evaluation.v1');
  assert.equal(dataset.repositoryKey, 'argus/pino-code-intelligence-benchmark');
  assert.deepEqual(dataset.cases.map(item => item.id), [
    'upstream-ticket', 'symptom-paraphrase', 'protocol-paraphrase',
  ]);
  for (const item of dataset.cases) {
    assert.deepEqual(item.expectedFiles, ['lib/multistream.js', 'test/multistream.test.js']);
    assert.equal(item.limit, 5);
  }
});
