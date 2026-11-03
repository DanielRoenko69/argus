import pg from 'pg';
import { PostgresIncidentAiopsTaskStore } from '../observability/incidentAiopsTasks.js';
import { PostgresIncidentRemediationStore } from '../observability/incidentRemediations.js';
import { aiopsDemoRemediationFromEnvironment, withBoundDemoRemediation } from './aiopsDemoRemediation.js';

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');
  const requestedIncidentId = Number(process.env['ARGUS_AIOPS_INCIDENT_ID'] ?? 0);
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const incident = Number.isSafeInteger(requestedIncidentId) && requestedIncidentId > 0
      ? { id: requestedIncidentId }
      : (await pool.query<{ id: number }>(
        `SELECT incident.id
           FROM mcp_observability_alert_incidents incident
          WHERE EXISTS (
            SELECT 1 FROM mcp_observability_incident_aiops_tasks task
             WHERE task.incident_id=incident.id
               AND task.state='TASK_STATE_COMPLETED'
               AND task.result_json IS NOT NULL
          )
          ORDER BY incident.triggered_at DESC, incident.id DESC LIMIT 1`,
      )).rows[0];
    if (!incident) throw new Error('No AIOps demo incident was found');
    const incidentId = Number(incident.id);
    if (!Number.isSafeInteger(incidentId) || incidentId < 1) throw new Error('Resolved incident id is invalid');
    const taskStore = new PostgresIncidentAiopsTaskStore(pool);
    const latest = (await taskStore.list(incidentId, 20))
      .find(task => task.state === 'TASK_STATE_COMPLETED' && task.result != null);
    if (!latest) throw new Error(`Incident ${incidentId} has no completed structured AIOps investigation`);
    const remediationStore = new PostgresIncidentRemediationStore(pool);
    const created = await remediationStore.syncFromInvestigation(withBoundDemoRemediation(
      latest,
      aiopsDemoRemediationFromEnvironment(),
    ));
    process.stdout.write(`${JSON.stringify({ ok: true, incidentId, taskId: latest.taskId, created }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-remediation-demo] failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
