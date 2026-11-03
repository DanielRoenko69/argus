import pg from 'pg';

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  const incidentId = positiveInteger(process.env['ARGUS_AIOPS_INCIDENT_ID']);
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');
  if (incidentId == null) throw new Error('ARGUS_AIOPS_INCIDENT_ID must be a positive integer');
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ rule_id: number; plan_id: number; verified_at: Date | string }>(
      `SELECT incident.rule_id, plan.id AS plan_id, plan.verified_at
         FROM mcp_observability_alert_incidents incident
         JOIN mcp_observability_incident_remediations remediation ON remediation.incident_id=incident.id
         JOIN mcp_observability_incident_remediation_change_plans plan ON plan.remediation_id=remediation.id
        WHERE incident.id=$1
          AND remediation.execution_intent->>'adapterKey'='kubernetes.deployment-revision-rollback.v1'
          AND plan.adapter_key='kubernetes.deployment-revision-rollback.v1'
          AND plan.status='verified'
          AND plan.verified_at IS NOT NULL
        ORDER BY plan.verified_at DESC, plan.id DESC
        LIMIT 1
        FOR UPDATE OF incident`,
      [incidentId],
    );
    const verified = result.rows[0];
    if (!verified) {
      throw new Error(`Incident ${incidentId} has no verified Deployment revision rollback plan`);
    }
    await client.query(
      `UPDATE mcp_observability_alert_incidents
          SET state='recovered', recovered_at=COALESCE(recovered_at, now()), metric_value=0,
              message='checkout-api recovered after the approved Deployment revision was restored and verified by Argus Core.',
              context=context || $2::jsonb, updated_at=now()
        WHERE id=$1`,
      [incidentId, JSON.stringify({ recoveredBy: 'argus-governed-revision-rollback', verifiedPlanId: Number(verified.plan_id) })],
    );
    await client.query(
      `UPDATE mcp_observability_alert_rules
          SET last_state='ok', last_value=0, last_sample_count=1,
              last_evaluated_at=now(), updated_at=now()
        WHERE id=$1`,
      [verified.rule_id],
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      incidentId,
      verifiedPlanId: Number(verified.plan_id),
      verifiedAt: new Date(verified.verified_at).toISOString(),
      state: 'recovered',
    }, null, 2)}\n`);
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-deployment-demo] completion failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
