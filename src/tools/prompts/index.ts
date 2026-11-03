import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { SessionContext } from '../../server/mcpServer.js';
import { logger } from '../../lib/logger.js';
import { writeAuditEntry } from '../../lib/audit.js';

interface SkillRow {
  id: number;
  name: string;
  label: string;
  description: string;
  content: string;
  category: string | null;
}

/**
 * Load Argus skills from the DB and register each as an MCP "prompts"
 * primitive. The MCP prompts primitive is what IDEs like Cursor / Claude
 * Code / Continue.dev surface in their `/` slash menu — so devs get
 * Argus-managed skills as drop-in templates without copying markdown
 * files into their workstation.
 *
 * Naming: "skill.<name>" so IDE-rendered list groups them under one
 * obvious prefix.
 */
async function registerSkillsAsPrompts(server: McpServer, pool: pg.Pool, sessionCtx?: SessionContext): Promise<number> {
  try {
    // Bundle-scoped session (e.g. /mcp/group/<bundle>) sees ONLY the skills
    // that admin explicitly bound to that bundle via mcp_bundle_skills.
    // Global /mcp endpoint sees all skills.
    let rows: SkillRow[];
    const allowedBundles = sessionCtx?.allowedBundles;
    if (Array.isArray(allowedBundles) && allowedBundles.length > 0) {
      const r = await pool.query<SkillRow>(
        `SELECT DISTINCT s.id, s.name, s.label, s.description, s.content, s.category
           FROM mcp_skills s
           JOIN mcp_bundle_skills bs ON bs.skill_id = s.id
          WHERE bs.bundle_id = ANY($1::int[])
          ORDER BY category NULLS LAST, label`,
        [allowedBundles],
      );
      rows = r.rows;
    } else {
      const r = await pool.query<SkillRow>(
        `SELECT id, name, label, description, content, category
           FROM mcp_skills
          ORDER BY category NULLS LAST, label`,
      );
      rows = r.rows;
    }

    for (const skill of rows) {
      const promptName = `skill.${skill.name}`;
      const description = skill.description || `Argus skill: ${skill.label}`;
      server.prompt(
        promptName,
        description,
        {
          // Optional free-text context the dev can fill in via the IDE picker
          // to specialize the skill (e.g. compliance audit target, ticket id).
          context: z.string().optional().describe('Optional context to specialize the skill for this invocation'),
        },
        async ({ context }: { context?: string }) => {
          const t0 = Date.now();
          const text = context
            ? `${skill.content}\n\n---\n\nContext for this invocation:\n${context}`
            : skill.content;
          // Audit-log the skill fetch so OPs can answer "which devs use
          // which skills via Cursor / Claude Code". param_summary holds
          // the optional dev-supplied context (truncated) for traceability
          // without storing the full skill body (we have that in mcp_skills).
          writeAuditEntry({
            apiKeyPrefix: sessionCtx?.apiKeyPrefix ?? 'unknown',
            tool:         `prompt.${promptName}`,
            parameters:   { skill_id: skill.id, skill_name: skill.name, context_len: context?.length ?? 0 },
            durationMs:   Date.now() - t0,
            resultSize:   text.length,
            isError:      false,
          }).catch(() => { /* never block the IDE response */ });
          return {
            messages: [{
              role: 'user',
              content: { type: 'text', text },
            }],
          };
        },
      );
    }
    return rows.length;
  } catch (err) {
    logger.warn({ err }, 'Failed to register skills as MCP prompts — continuing without skill prompts');
    return 0;
  }
}

export function registerPrompts(
  server: McpServer,
  _config: Config,
  sessionCtx?: SessionContext,
  pool?: pg.Pool,
): void {
  // ── Bundle-scoped system prompt ───────────────────────────────
  if (sessionCtx?.systemPrompt) {
    const role = sessionCtx.agentRole ?? 'AI Assistent';
    const systemPromptText = sessionCtx.systemPrompt;
    server.prompt(
      'bundle-context',
      `Kontext und Rolle für diesen Bundle-Endpunkt: ${role}`,
      {},
      async () => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: systemPromptText,
          },
        }],
      }),
    );
  }
  server.prompt(
    'cluster-health-check',
    'Comprehensive cluster health analysis: checks nodes, failing pods, recent events, and alerts',
    {},
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a comprehensive health check of the Kubernetes cluster. Follow these steps:

1. Check node status. Report any nodes that are NotReady.
2. List pods (all namespaces) to find pods that are not Running/Succeeded. Focus on CrashLoopBackOff, Error, Pending states.
3. Get events (all namespaces) to find Warning events from the last hour.
4. Check for any firing alerts if a monitoring backend is available.

Summarize findings in a structured report with severity levels (Critical, Warning, Info).`,
        },
      }],
    })
  );

  server.prompt(
    'investigate-service',
    'Deep-dive investigation of a specific service: pods, logs, metrics, and recent changes',
    {
      service: z.string().describe('Name of the service to investigate'),
      namespace: z.string().describe('Namespace of the service'),
    },
    async ({ service, namespace }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Investigate the service "${service}" in namespace "${namespace}". Follow these steps:

1. Get the service details and find the selector labels.
2. List pods with the label selector from step 1 to find all backing pods.
3. For any unhealthy pods, check recent logs for errors.
4. Find events in namespace "${namespace}" related to this service or its pods.
5. If monitoring tools are available, check request rates and error rates.
6. If log search tools are available, find recent error logs related to "${service}".

Provide a detailed analysis with:
- Current state of the service and its pods
- Any errors or anomalies found
- Potential root causes
- Recommended actions`,
        },
      }],
    })
  );

  server.prompt(
    'capacity-planning',
    'Analyze cluster resource utilization and provide capacity planning insights',
    {},
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a capacity analysis of the Kubernetes cluster:

1. Get node capacity and allocatable resources.
2. List pods (all namespaces) to understand workload distribution.
3. List deployments (all namespaces) to see replica counts.
4. If monitoring tools are available, query CPU and memory usage metrics.

Provide:
- Current utilization per node (CPU, Memory)
- Most resource-intensive workloads
- Headroom analysis (how much capacity is left)
- Recommendations for scaling`,
        },
      }],
    })
  );

  server.prompt(
    'runbook-pod-crashloop',
    'Runbook: Diagnose and resolve CrashLoopBackOff pods',
    {
      namespace: z.string().optional().describe('Namespace to check (omit for all)'),
    },
    async ({ namespace }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `RUNBOOK: CrashLoopBackOff Resolution
${namespace ? `Scope: namespace "${namespace}"` : 'Scope: all namespaces'}

Step 1: Find affected pods
- List pods${namespace ? ` (namespace: "${namespace}")` : ''} and filter for CrashLoopBackOff status

Step 2: For each affected pod:
- Get the most recent logs (tailLines: 200)
- Find related events
- Check resource limits, image versions, and environment

Step 3: Common causes to check:
- Application errors in logs (null pointers, missing config, connection refused)
- OOMKilled (check events and resource limits)
- Image pull errors
- Missing ConfigMaps or Secrets
- Liveness probe failures

Step 4: Report findings and recommended fix for each pod.`,
        },
      }],
    })
  );

  server.prompt(
    'runbook-high-latency',
    'Runbook: Diagnose high latency in a service',
    {
      service: z.string().describe('Service name'),
      namespace: z.string().describe('Namespace'),
    },
    async ({ service, namespace }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `RUNBOOK: High Latency Diagnosis for "${service}" in "${namespace}"

Step 1: Check service health
- List pods (namespace: "${namespace}") to check pod status
- Get deployment details for replica status

Step 2: Check recent changes
- Get events (namespace: "${namespace}") for recent deployments or scaling events

Step 3: Check metrics (if monitoring tools available)
- Query p99 latency, request rate
- Compare with 1h ago to identify when latency increased

Step 4: Check logs
- Get pod logs for each pod, looking for timeout errors, slow query warnings, connection pool exhaustion

Step 5: Report findings with timeline and recommended actions.`,
        },
      }],
    })
  );

  // Argus-managed skills (loaded from mcp_skills) appear as MCP prompts
  // named "skill.<name>". When pool is missing (e.g. test contexts), we
  // skip skill registration silently — the static runbook prompts above
  // are still available.
  if (pool) {
    void registerSkillsAsPrompts(server, pool, sessionCtx).then(n => {
      logger.info({ count: n }, `MCP Prompts registered (+ ${n} skill.* prompts from DB)`);
    });
  } else {
    logger.info('MCP Prompts registered (skill.* prompts skipped — no pool)');
  }
}
