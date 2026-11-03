#!/usr/bin/env node
/**
 * Behavioral certification for migration 219.
 *
 * The command never falls back to the developer database. Point
 * RUN_RESOURCE_SNAPSHOT_CERTIFICATION_DATABASE_URL at an explicitly disposable
 * database whose migration chain is current.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = (process.env.RUN_RESOURCE_SNAPSHOT_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REPORT
  || 'test-results/run-resource-snapshot-certification.json';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function refsFrom(value) {
  return Array.isArray(value) ? value : [];
}

function resourceRef(refs, type, id) {
  return refs.find(ref => ref && ref.type === type && String(ref.id) === String(id));
}

function tagLabel(ref) {
  return Array.isArray(ref?.tags) ? ref.tags[0]?.label : undefined;
}

async function certify(client) {
  const suffix = randomBytes(5).toString('hex');
  await client.query('BEGIN');
  try {
    const agent = (await client.query(
      `INSERT INTO mcp_agents (name, label, description, model)
       VALUES ($1, $2, '', 'certification-model') RETURNING id`,
      [`tag003-agent-${suffix}`, `TAG-003 Agent ${suffix}`],
    )).rows[0];
    const workflow = (await client.query(
      `INSERT INTO mcp_workflows (name, description, steps, input_params, enabled)
       VALUES ($1, '', '[]'::jsonb, '[]'::jsonb, true) RETURNING id, name`,
      [`tag003_workflow_${suffix}`],
    )).rows[0];
    await client.query(
      `INSERT INTO mcp_workflow_versions (workflow_id, version, steps, input_params)
       VALUES ($1, 1, '[]'::jsonb, '[]'::jsonb)`,
      [workflow.id],
    );
    const workflowTag = (await client.query(
      `INSERT INTO mcp_workspace_tags (workspace_key, slug, label, color)
       VALUES ('default', $1, 'Workflow Before', '#112233') RETURNING id`,
      [`workflow-before-${suffix}`],
    )).rows[0];
    const agentTag = (await client.query(
      `INSERT INTO mcp_workspace_tags (workspace_key, slug, label, color)
       VALUES ('default', $1, 'Agent Before', '#445566') RETURNING id`,
      [`agent-before-${suffix}`],
    )).rows[0];
    await client.query(
      `INSERT INTO mcp_resource_tag_assignments
         (workspace_key, tag_id, resource_type, resource_id)
       VALUES ('default', $1, 'workflow', $2), ('default', $3, 'agent', $4)`,
      [workflowTag.id, String(workflow.id), agentTag.id, String(agent.id)],
    );

    const snapshot = {
      schemaVersion: 1,
      kind: 'workflow-agent-contract',
      assignments: [{ agentId: agent.id, role: 'certifier', stepIds: ['certify'] }],
    };
    const execution = (await client.query(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot)
       VALUES ($1, 'running', 'tag003-certifier', '{}'::jsonb, $2::jsonb)
       RETURNING id, execution_snapshot`,
      [workflow.id, JSON.stringify(snapshot)],
    )).rows[0];

    const traceId = randomUUID();
    const trace = (await client.query(
      `INSERT INTO mcp_observability_traces
         (id, root_trace_id, name, kind, status, agent_id, started_at, metadata)
       VALUES ($1, $1, 'tag003.agent', 'agent', 'running', $2, now(), '{"phase":"before"}'::jsonb)
       RETURNING metadata`,
      [traceId, agent.id],
    )).rows[0];

    const workflowRefs = refsFrom(execution.execution_snapshot?.resourceRefs);
    const frozenWorkflow = resourceRef(workflowRefs, 'workflow', workflow.id);
    const frozenWorkflowAgent = resourceRef(workflowRefs, 'agent', agent.id);
    const frozenTraceAgent = resourceRef(refsFrom(trace.metadata?.resourceRefs), 'agent', agent.id);
    assert(workflowRefs.length === 2, 'workflow execution did not freeze exactly its Workflow and resolved Agent refs');
    assert(frozenWorkflow?.version === '1', 'workflow version was not frozen');
    assert(tagLabel(frozenWorkflow) === 'Workflow Before', 'workflow tag was not frozen');
    assert(tagLabel(frozenWorkflowAgent) === 'Agent Before', 'workflow Agent tag was not frozen');
    assert(tagLabel(frozenTraceAgent) === 'Agent Before', 'Agent telemetry tag was not frozen');

    await client.query(`UPDATE mcp_workspace_tags SET label='Workflow After' WHERE id=$1`, [workflowTag.id]);
    await client.query(`UPDATE mcp_workspace_tags SET label='Agent After' WHERE id=$1`, [agentTag.id]);
    await client.query(`UPDATE mcp_agents SET label='TAG-003 Agent After' WHERE id=$1`, [agent.id]);
    await client.query(
      `UPDATE mcp_workflow_executions
          SET execution_snapshot=jsonb_set(execution_snapshot, '{resourceRefs}', '[{"type":"tampered"}]'::jsonb)
        WHERE id=$1`,
      [execution.id],
    );
    await client.query(
      `UPDATE mcp_observability_traces
          SET metadata=jsonb_build_object('phase', 'after', 'resourceRefs', '[{"type":"tampered"}]'::jsonb)
        WHERE id=$1`,
      [traceId],
    );

    const preservedExecution = (await client.query(
      `SELECT execution_snapshot FROM mcp_workflow_executions WHERE id=$1`,
      [execution.id],
    )).rows[0];
    const preservedTrace = (await client.query(
      `SELECT metadata FROM mcp_observability_traces WHERE id=$1`,
      [traceId],
    )).rows[0];
    const preservedWorkflowRefs = refsFrom(preservedExecution.execution_snapshot?.resourceRefs);
    assert(tagLabel(resourceRef(preservedWorkflowRefs, 'workflow', workflow.id)) === 'Workflow Before',
      'workflow tag snapshot changed after catalog mutation');
    assert(tagLabel(resourceRef(preservedWorkflowRefs, 'agent', agent.id)) === 'Agent Before',
      'workflow Agent snapshot changed after catalog mutation');
    assert(tagLabel(resourceRef(refsFrom(preservedTrace.metadata?.resourceRefs), 'agent', agent.id)) === 'Agent Before',
      'Agent trace snapshot changed after catalog mutation');
    assert(preservedTrace.metadata?.phase === 'after', 'ordinary telemetry metadata update was blocked');

    const laterExecution = (await client.query(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot)
       VALUES ($1, 'running', 'tag003-certifier', '{}'::jsonb, $2::jsonb)
       RETURNING execution_snapshot`,
      [workflow.id, JSON.stringify(snapshot)],
    )).rows[0];
    const laterRefs = refsFrom(laterExecution.execution_snapshot?.resourceRefs);
    assert(tagLabel(resourceRef(laterRefs, 'workflow', workflow.id)) === 'Workflow After',
      'new workflow execution did not capture current tags');
    assert(tagLabel(resourceRef(laterRefs, 'agent', agent.id)) === 'Agent After',
      'new workflow execution did not capture current Agent tags');

    await client.query('ROLLBACK');
    return {
      workflow_refs: workflowRefs.length,
      agent_trace_refs: refsFrom(trace.metadata?.resourceRefs).length,
      frozen_update_guard: true,
      new_run_observes_current_catalog: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    database: 'disposable database not configured',
  };
  if (databaseUrl) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      report.database = await certify(client);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.database = safeError(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed' || (required && report.status !== 'passed')) process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
