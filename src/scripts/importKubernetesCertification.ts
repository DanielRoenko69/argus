import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import {
  importKubernetesCertification,
  normalizeKubernetesCertificationReport,
} from '../solutionPacks/kubernetesCertificationStore.js';

const MAX_REPORT_BYTES = 500 * 1024;

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const reportPath = option('--report', 'test-results/kubernetes-connector-certification.json')!;
  const importedBy = option('--imported-by', 'local-certification-cli')!;
  const explicitBackendId = option('--backend-id');
  const connectionString = process.env['DATABASE_URL'] ?? process.env['POSTGRES_CONNECTION_URL'];
  if (!connectionString) throw new Error('DATABASE_URL or POSTGRES_CONNECTION_URL must be configured');

  const reportStats = await stat(reportPath);
  if (!reportStats.isFile() || reportStats.size < 2 || reportStats.size > MAX_REPORT_BYTES) {
    throw new Error(`Certification report must be a JSON file smaller than ${MAX_REPORT_BYTES} bytes`);
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
  const normalized = normalizeKubernetesCertificationReport(report);
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    let backendId = explicitBackendId == null ? null : Number(explicitBackendId);
    if (backendId == null) {
      const candidates = await pool.query<{ id: number }>(
        `SELECT id
           FROM mcp_backends
          WHERE enabled=true AND config->>'target_id'=$1
          ORDER BY id`,
        [normalized.targetId],
      );
      if (candidates.rows.length !== 1) {
        throw new Error(`Expected exactly one enabled MCP backend for target ${normalized.targetId}; pass --backend-id explicitly`);
      }
      backendId = candidates.rows[0]!.id;
    }
    if (!Number.isSafeInteger(backendId) || backendId < 1) throw new Error('--backend-id must be a positive integer');
    const imported = await importKubernetesCertification(pool, { backendId, report, importedBy });
    process.stdout.write(`${JSON.stringify({
      backendId: imported.backendId,
      targetId: imported.targetId,
      platform: imported.platform,
      status: imported.status,
      checks: imported.checkCount,
      passed: imported.passedCount,
      failed: imported.failedCount,
      generatedAt: imported.generatedAt,
      reportSha256: imported.reportSha256,
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
