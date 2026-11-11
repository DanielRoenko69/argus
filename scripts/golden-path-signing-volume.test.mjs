import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const overlay = await readFile(resolve(root, 'deploy/compose/e2e/compose.golden-path.e2e.yml'), 'utf8');

test('Golden Path transfers its host key into a disposable least-readable volume', () => {
  assert.match(overlay, /audit-signing-key-init:/u);
  assert.match(overlay, /chown 1000:1000 \/target\/argus-audit-signing-key\.pem/u);
  assert.match(overlay, /chmod 0600 \/target\/argus-audit-signing-key\.pem/u);
  assert.match(overlay, /condition: service_completed_successfully/u);
  assert.match(overlay, /golden-path-audit-signing:\/run\/secrets\/audit:ro/u);
  assert.doesNotMatch(
    overlay,
    /\.\/secrets\/argus-audit-signing-key\.pem:\/run\/secrets/u,
    'the host-owned 0600 file must not be mounted directly into the non-root Argus container',
  );
});
