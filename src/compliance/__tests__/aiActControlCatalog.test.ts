import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { stableAuditJson, type AuditJsonValue } from '../../audit/canonicalAuditRedaction.js';
import { aiActControlCatalogSchema } from '../aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG, matchesAiActControlCatalogPin } from '../aiActControlCatalog.js';

describe('server-owned EU AI Act control catalog', () => {
  it('matches the checked-in interoperability fixture and its canonical digest', () => {
    const fixture = aiActControlCatalogSchema.parse(JSON.parse(readFileSync(resolve(
      process.cwd(),
      'docs/specs/ai-act-compliance/control-catalog.v1.fixture.json',
    ), 'utf8')));
    const { catalogSha256, ...withoutDigest } = fixture;
    const recomputed = createHash('sha256')
      .update(stableAuditJson(JSON.parse(JSON.stringify(withoutDigest)) as AuditJsonValue), 'utf8')
      .digest('hex');

    expect(recomputed).toBe(catalogSha256);
    expect(fixture).toEqual(AI_ACT_CONTROL_CATALOG);
  });

  it('has unique controls and recognizes only the exact active catalog pin', () => {
    expect(AI_ACT_CONTROL_CATALOG.controls).toHaveLength(8);
    expect(new Set(AI_ACT_CONTROL_CATALOG.controls.map(control => control.controlId)).size).toBe(8);
    expect(matchesAiActControlCatalogPin(AI_ACT_CONTROL_CATALOG)).toBe(true);
    expect(matchesAiActControlCatalogPin({ ...AI_ACT_CONTROL_CATALOG, catalogSha256: '0'.repeat(64) })).toBe(false);
  });
});
