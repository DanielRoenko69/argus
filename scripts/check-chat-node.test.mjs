import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chatNodeRange, supportsChatNode } from './check-chat-node.mjs';

test('Chat engine gate accepts supported versions including the exact minimums', () => {
  for (const version of ['20.19.0', '20.20.1', '22.12.0', '22.20.0', '24.0.0', '24.14.0', '26.0.0']) {
    assert.equal(supportsChatNode(version), true, version);
  }
});
test('Chat engine gate rejects old, unsupported odd versions and malformed input', () => {
  for (const version of ['18.20.0', '20.18.9', '21.7.0', '22.11.9', '23.1.0', '', '24', '24.0.0-rc.1']) {
    assert.equal(supportsChatNode(version), false, version);
  }
});
test('Chat package engine and workstation guards agree', async () => {
  const pkg = JSON.parse(await readFile(new URL('../argus-chat-ui/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, chatNodeRange);
  for (const file of ['local-platform-doctor.mjs']) {
    assert.match(await readFile(new URL(file, import.meta.url), 'utf8'), /check-chat-node\.mjs/);
  }
});
