import pg from 'pg';
import {
  normalizePublicWidgetOrigin,
  type PublicWidget,
  type PublicWidgetAgent,
} from './widgetStore.js';

export const PUBLIC_WIDGET_DEMO_AGENT_NAME = 'public_demo_assistant';
export const PUBLIC_WIDGET_DEMO_SLUG = 'argus-public-demo';

const PUBLIC_DEMO_PROMPT = `You are the Argus Public Demo Assistant.

Explain Argus, Argus Dev and Argus AIOps in clear language to website visitors. Keep answers concise, factual and suitable for a first product demonstration. Never request credentials or personal data. Never claim to have used tools, changed systems or inspected private information. If a request requires internal access, explain that the public demo is intentionally isolated.`;

export class PublicWidgetDemoError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PublicWidgetDemoError';
    this.status = status;
  }
}

export interface PublicWidgetDemoResult {
  agent: PublicWidgetAgent | null;
  widget: PublicWidget | null;
}

interface DemoAgentRow extends PublicWidgetAgent, pg.QueryResultRow {
  model: string;
  runtime_profile_id: number | null;
  runtime_enabled: boolean | null;
}

interface RuntimeSourceRow extends pg.QueryResultRow {
  model: string;
  runtime_profile_id: number;
}

export function normalizePublicWidgetDemoOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PublicWidgetDemoError('A local HTTP(S) origin is required');
  }
  const origin = normalizePublicWidgetOrigin(value);
  if (!origin) throw new PublicWidgetDemoError('The demo origin must be an exact HTTP(S) origin');
  const hostname = new URL(origin).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new PublicWidgetDemoError('Prototype setup only accepts localhost or loopback origins');
  }
  return origin;
}

async function loadDemoAgent(client: pg.PoolClient): Promise<DemoAgentRow | null> {
  const { rows } = await client.query<DemoAgentRow>(
    `SELECT agent.id, agent.name, agent.label, agent.enabled, agent.visibility,
            agent.model, agent.runtime_profile_id,
            runtime.enabled AS runtime_enabled
       FROM mcp_agents agent
       LEFT JOIN mcp_agent_runtime_profiles runtime ON runtime.id=agent.runtime_profile_id
      WHERE agent.name=$1
      LIMIT 1`,
    [PUBLIC_WIDGET_DEMO_AGENT_NAME],
  );
  return rows[0] ?? null;
}

async function loadDemoWidget(client: pg.PoolClient): Promise<PublicWidget | null> {
  const { rows } = await client.query<PublicWidget>(
    `SELECT id, agent_id, slug, allowed_origins, enabled, greeting, accent,
            title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
            rate_limit_per_ip, daily_token_cap, created_by, created_at
       FROM mcp_public_widgets
      WHERE slug=$1
      LIMIT 1`,
    [PUBLIC_WIDGET_DEMO_SLUG],
  );
  return rows[0] ?? null;
}

async function selectRuntimeSource(
  client: pg.PoolClient,
  existing: DemoAgentRow | null,
): Promise<RuntimeSourceRow> {
  if (existing?.runtime_profile_id && existing.runtime_enabled) {
    return { model: existing.model, runtime_profile_id: existing.runtime_profile_id };
  }
  const { rows } = await client.query<RuntimeSourceRow>(
    `SELECT agent.model, agent.runtime_profile_id
       FROM mcp_agents agent
       JOIN mcp_agent_runtime_profiles runtime ON runtime.id=agent.runtime_profile_id
      WHERE agent.enabled=true
        AND agent.agent_mode='chat'
        AND agent.name<>$1
        AND runtime.enabled=true
      ORDER BY CASE agent.name
        WHEN 'researcher' THEN 0
        WHEN 'workflow_copilot' THEN 1
        WHEN 'planner' THEN 2
        ELSE 3
      END, agent.id
      LIMIT 1`,
    [PUBLIC_WIDGET_DEMO_AGENT_NAME],
  );
  if (!rows[0]) {
    throw new PublicWidgetDemoError(
      'No enabled chat runtime is available. Configure an Agent Runtime Profile first.',
      409,
    );
  }
  return rows[0];
}

export async function provisionPublicWidgetDemo(
  pool: pg.Pool,
  input: { origin: string; websiteOrigins?: string[]; createdBy: number },
): Promise<PublicWidgetDemoResult> {
  const origin = normalizePublicWidgetDemoOrigin(input.origin);
  const allowedOrigins = Array.from(new Set([
    origin,
    ...(input.websiteOrigins ?? []).map(normalizePublicWidgetDemoOrigin),
  ]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await loadDemoAgent(client);
    const runtime = await selectRuntimeSource(client, existing);

    const agentResult = existing
      ? await client.query<PublicWidgetAgent>(
          `UPDATE mcp_agents
              SET label='Public Demo Assistant',
                  description='Isolated local assistant for demonstrating the Argus public widget.',
                  model=$2,
                  temperature=0.3,
                  max_tokens=2048,
                  system_prompt=$3,
                  agent_role='public-assistant',
                  composite_id=NULL,
                  enabled=true,
                  max_iterations=4,
                  agent_mode='chat',
                  task_type=NULL,
                  allowed_paths=NULL,
                  bundle_ids=ARRAY[]::integer[],
                  llm_credential_profile_id=NULL,
                  runtime_profile_id=$4,
                  thinking_budget=0,
                  untrusted_tool_output_enforcement=true,
                  codegraph_enabled=false,
                  visibility='public',
                  min_role=NULL,
                  risk_level='low',
                  human_oversight_required=false,
                  updated_at=now()
            WHERE id=$1
        RETURNING id, name, label, enabled, visibility`,
          [existing.id, runtime.model, PUBLIC_DEMO_PROMPT, runtime.runtime_profile_id],
        )
      : await client.query<PublicWidgetAgent>(
          `INSERT INTO mcp_agents
             (name, label, description, model, temperature, max_tokens, system_prompt,
              agent_role, composite_id, enabled, max_iterations, created_by, agent_mode,
              task_type, allowed_paths, bundle_ids, llm_credential_profile_id,
              runtime_profile_id, thinking_budget, untrusted_tool_output_enforcement,
              codegraph_enabled, visibility, min_role, risk_level, human_oversight_required)
           VALUES
             ($1, 'Public Demo Assistant',
              'Isolated local assistant for demonstrating the Argus public widget.',
              $2, 0.3, 2048, $3, 'public-assistant', NULL, true, 4, $4, 'chat',
              NULL, NULL, ARRAY[]::integer[], NULL, $5, 0, true, false, 'public',
              NULL, 'low', false)
        RETURNING id, name, label, enabled, visibility`,
          [PUBLIC_WIDGET_DEMO_AGENT_NAME, runtime.model, PUBLIC_DEMO_PROMPT, input.createdBy, runtime.runtime_profile_id],
        );
    const agent = agentResult.rows[0]!;

    // Re-provisioning must not inherit capabilities added to a previous demo.
    await client.query('DELETE FROM mcp_agent_rag_indexes WHERE agent_id=$1', [agent.id]);
    await client.query('DELETE FROM mcp_agent_skills WHERE agent_id=$1', [agent.id]);

    const existingWidget = await loadDemoWidget(client);
    const widgetResult = existingWidget
      ? await client.query<PublicWidget>(
          `UPDATE mcp_public_widgets
              SET agent_id=$2,
                  allowed_origins=$3::text[],
                  enabled=true,
                  greeting='Hi! Ask me what Argus, Argus Dev or Argus AIOps can do.',
                  accent='#8b5cf6',
                  title='Ask Argus',
                  input_placeholder='Ask Argus a question...',
                  launcher_icon_url='http://localhost:4173/argus-mark.svg',
                  launcher_icon_alt='Open the Argus assistant',
                  launcher_position='right',
                  rate_limit_per_ip=20,
                  daily_token_cap=10000
            WHERE id=$1
        RETURNING id, agent_id, slug, allowed_origins, enabled, greeting, accent,
                  title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
                  rate_limit_per_ip, daily_token_cap, created_by, created_at`,
          [existingWidget.id, agent.id, allowedOrigins],
        )
      : await client.query<PublicWidget>(
          `INSERT INTO mcp_public_widgets
             (agent_id, slug, allowed_origins, enabled, greeting, accent,
              title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
              rate_limit_per_ip, daily_token_cap, created_by)
           VALUES ($1, $2, $3::text[], true,
                   'Hi! Ask me what Argus, Argus Dev or Argus AIOps can do.',
                   '#8b5cf6', 'Ask Argus', 'Ask Argus a question...',
                   'http://localhost:4173/argus-mark.svg', 'Open the Argus assistant', 'right',
                   20, 10000, $4)
        RETURNING id, agent_id, slug, allowed_origins, enabled, greeting, accent,
                  title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
                  rate_limit_per_ip, daily_token_cap, created_by, created_at`,
          [agent.id, PUBLIC_WIDGET_DEMO_SLUG, allowedOrigins, input.createdBy],
        );
    await client.query('COMMIT');
    return { agent, widget: widgetResult.rows[0]! };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function disablePublicWidgetDemo(pool: pg.Pool): Promise<PublicWidgetDemoResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const widgetResult = await client.query<PublicWidget>(
      `UPDATE mcp_public_widgets
          SET enabled=false
        WHERE slug=$1
    RETURNING id, agent_id, slug, allowed_origins, enabled, greeting, accent,
              title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
              rate_limit_per_ip, daily_token_cap, created_by, created_at`,
      [PUBLIC_WIDGET_DEMO_SLUG],
    );
    const agentResult = await client.query<PublicWidgetAgent>(
      `UPDATE mcp_agents
          SET enabled=false, visibility='internal', updated_at=now()
        WHERE name=$1
    RETURNING id, name, label, enabled, visibility`,
      [PUBLIC_WIDGET_DEMO_AGENT_NAME],
    );
    await client.query('COMMIT');
    return { agent: agentResult.rows[0] ?? null, widget: widgetResult.rows[0] ?? null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
