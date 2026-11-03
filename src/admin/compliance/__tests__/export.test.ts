import { describe, expect, it } from '@jest/globals';
import { complianceRunHash, exportCsv } from '../export.js';
import type { Finding, Framework, Run } from '../store.js';

const framework: Framework = {
  id: 2, slug: 'nis2', label: 'NIS2', version: '2022/2555', jurisdiction: 'EU',
  skill_id: 4, rag_index_id: null, description: 'Directive checklist', enabled: true,
  created_at: '2026-08-01T10:00:00.000Z',
};
const run: Run = {
  id: 41, framework_id: 2, framework_slug: 'nis2', framework_label: 'NIS2', target: 'argus-prod',
  agent_id: 7, status: 'completed', score: 50, passed_count: 0, warning_count: 1,
  failed_count: 0, na_count: 0, triggered_by: 'admin', started_at: '2026-08-01T10:00:00.000Z',
  completed_at: '2026-08-01T10:01:00.000Z', duration_ms: 60_000, error_message: null,
};
const finding: Finding = {
  id: 9, run_id: 41, article: 'Art. 21', title: 'Incident handling', verdict: 'warning',
  severity: 'high', evidence: '=HYPERLINK("https://attacker.test")',
  remediation: 'Add an incident runbook', code_pointers: [{ file: 'docs/runbook.md', line: 7, snippet: 'TODO' }],
  created_at: '2026-08-01T10:00:30.000Z',
};

describe('compliance evidence exports', () => {
  it('includes provenance and neutralizes spreadsheet formulas', () => {
    const csv = exportCsv(framework, run, [finding]);
    expect(csv).toContain('run_id,framework,framework_version,target');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('argus-prod');
  });

  it('binds evidence, remediation and code pointers into the report hash', () => {
    const baseline = complianceRunHash(run, [finding]);
    expect(complianceRunHash(run, [{ ...finding, evidence: 'Different evidence' }])).not.toBe(baseline);
    expect(complianceRunHash(run, [{ ...finding, remediation: 'Different remediation' }])).not.toBe(baseline);
    expect(complianceRunHash(run, [{ ...finding, code_pointers: [{ file: 'other.ts', line: 1 }] }])).not.toBe(baseline);
  });
});
