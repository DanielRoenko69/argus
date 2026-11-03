import pg from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  const demoRunId = process.env['ARGUS_AIOPS_DEMO_RUN_ID']?.trim() ?? '';
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(demoRunId)) {
    throw new Error('ARGUS_AIOPS_DEMO_RUN_ID must be a version-4 UUID');
  }
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: number; rule_id: number }>(
      `SELECT id, rule_id
         FROM mcp_observability_alert_incidents
        WHERE state='firing'
          AND context->>'source'='argus-controlled-aiops-demo'
          AND context->>'signal'='deployment_availability'
          AND context->>'demoRunId'=$1
        ORDER BY triggered_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [demoRunId],
    );
    const incident = result.rows[0];
    if (!incident) {
      await client.query('COMMIT');
      process.stdout.write(`${JSON.stringify({ ok: true, demoRunId, recoveredIncidentId: null })}\n`);
      return;
    }
    await client.query(
      `UPDATE mcp_observability_alert_incidents
          SET state='recovered', recovered_at=now(), metric_value=0,
              message='Controlled AIOps demo aborted; the operator cleanup guard restored the recorded healthy revision.',
              context=context || '{"demoAborted":true}'::jsonb, updated_at=now()
        WHERE id=$1`,
      [incident.id],
    );
    await client.query(
      `UPDATE mcp_observability_alert_rules
          SET last_state='ok', last_value=0, last_sample_count=1,
              last_evaluated_at=now(), updated_at=now()
        WHERE id=$1`,
      [incident.rule_id],
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({ ok: true, demoRunId, recoveredIncidentId: Number(incident.id) })}\n`);
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-deployment-demo] abort cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
