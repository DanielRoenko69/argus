import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./code-intelligence-handshake.mjs', import.meta.url), 'utf8');

test('index-only handshake builds an authorized snapshot without demo-specific retrieval assertions', () => {
  assert.match(source, /ARGUS_CODE_INDEX_ONLY === 'true'/);
  assert.match(source, /!indexOnly && effectiveCodeContextMode === 'bounded_source'/);
  assert.match(source, /reason: indexOnly/);
  assert.match(source, /'index_only'/);
  assert.match(source, /certification: 'native-code-intelligence-handshake'/);
});

test('index-only mode cannot silently bypass policy-cycle certification', () => {
  assert.match(source, /certifyPolicyCycle && indexOnly/);
  assert.match(source, /cannot be combined with ARGUS_CODE_INDEX_ONLY/);
});

test('long local indexes override Undici header and body timeouts explicitly', () => {
  assert.match(source, /new UndiciAgent/);
  assert.match(source, /headersTimeout: requestTimeoutMs/);
  assert.match(source, /bodyTimeout: requestTimeoutMs/);
  assert.match(source, /dispatcher,/);
  assert.match(source, /await dispatcher\.close\(\)/);
});
