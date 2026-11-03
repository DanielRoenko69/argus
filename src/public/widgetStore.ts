/**
 * widgetStore.ts — P3-3
 *
 * CRUD store for mcp_public_widgets.
 *
 * Key security rule: getWidgetBySlug (used by the public chat route) resolves
 * ONLY when ALL three conditions hold:
 *   1. mcp_public_widgets.enabled = true
 *   2. mcp_agents.visibility = 'public'
 *   3. mcp_agents.enabled = true
 *
 * Admin CRUD functions (list/create/update/delete) have no enabled/visibility
 * filter — management pages need to see all widgets.
 */

import pg from 'pg';

// ── Types ─────────────────────────────────────────────────────

export interface PublicWidget {
  id: number;
  agent_id: number;
  slug: string;
  allowed_origins: string[];
  enabled: boolean;
  greeting: string | null;
  accent: string | null;
  title: string | null;
  input_placeholder: string | null;
  launcher_icon_url: string | null;
  launcher_icon_alt: string | null;
  launcher_position: 'left' | 'right';
  rate_limit_per_ip: number;
  daily_token_cap: number;
  created_by: number | null;
  created_at: Date;
}

export interface CreateWidgetInput {
  agent_id: number;
  slug: string;
  allowed_origins?: string[];
  enabled?: boolean;
  greeting?: string | null;
  accent?: string | null;
  title?: string | null;
  input_placeholder?: string | null;
  launcher_icon_url?: string | null;
  launcher_icon_alt?: string | null;
  launcher_position?: 'left' | 'right';
  rate_limit_per_ip?: number;
  daily_token_cap?: number;
  created_by?: number | null;
}

export interface UpdateWidgetInput {
  agent_id?: number;
  slug?: string;
  allowed_origins?: string[];
  enabled?: boolean;
  greeting?: string | null;
  accent?: string | null;
  title?: string | null;
  input_placeholder?: string | null;
  launcher_icon_url?: string | null;
  launcher_icon_alt?: string | null;
  launcher_position?: 'left' | 'right';
  rate_limit_per_ip?: number;
  daily_token_cap?: number;
}

export interface PublicWidgetAgent {
  id: number;
  name: string;
  label: string;
  enabled: boolean;
  visibility: 'internal' | 'public';
}

// ── Normalise an origin string ────────────────────────────────

export function normalizePublicWidgetOrigin(origin: string): string | null {
  const value = origin.trim();
  if (!value || value.includes('*')) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// ── Origin allowlist check ────────────────────────────────────

/**
 * Returns true iff `origin` (case-insensitive, trailing-slash stripped) exactly
 * matches one of `widget.allowed_origins`.
 *
 * No wildcard matching — default-deny.
 */
export function isOriginAllowed(widget: PublicWidget, origin: string | undefined): boolean {
  if (!origin) return false;
  const normalised = normalizePublicWidgetOrigin(origin);
  if (!normalised) return false;
  return widget.allowed_origins.some(o => normalizePublicWidgetOrigin(o) === normalised);
}

// ── Public-facing lookup (defence-in-depth triple gate) ───────

/**
 * Fetch a widget by slug for use by the public chat route.
 *
 * Returns null unless:
 *   • mcp_public_widgets.enabled = true
 *   • mcp_agents.visibility = 'public'
 *   • mcp_agents.enabled = true
 */
export async function getWidgetBySlug(
  pool: pg.Pool,
  slug: string,
): Promise<PublicWidget | null> {
  const { rows } = await pool.query<PublicWidget>(
    // Triple gate — defence in depth:
    //   mcp_public_widgets.enabled = true  (widget not disabled by admin)
    //   mcp_agents.visibility = 'public'   (agent explicitly marked public)
    //   mcp_agents.enabled = true          (agent not soft-deleted/disabled)
    `SELECT mcp_public_widgets.id,
            mcp_public_widgets.agent_id,
            mcp_public_widgets.slug,
            mcp_public_widgets.allowed_origins,
            mcp_public_widgets.enabled,
            mcp_public_widgets.greeting,
            mcp_public_widgets.accent,
            mcp_public_widgets.title,
            mcp_public_widgets.input_placeholder,
            mcp_public_widgets.launcher_icon_url,
            mcp_public_widgets.launcher_icon_alt,
            mcp_public_widgets.launcher_position,
            mcp_public_widgets.rate_limit_per_ip,
            mcp_public_widgets.daily_token_cap,
            mcp_public_widgets.created_by,
            mcp_public_widgets.created_at
     FROM   mcp_public_widgets
     JOIN   mcp_agents ON mcp_agents.id = mcp_public_widgets.agent_id
     WHERE  mcp_public_widgets.slug    = $1
       AND  mcp_public_widgets.enabled = true
       AND  mcp_agents.visibility      = 'public'
       AND  mcp_agents.enabled         = true`,
    [slug],
  );
  return rows[0] ?? null;
}

// ── Admin CRUD ────────────────────────────────────────────────

export async function listWidgets(pool: pg.Pool): Promise<PublicWidget[]> {
  const { rows } = await pool.query<PublicWidget>(
    `SELECT id, agent_id, slug, allowed_origins, enabled, greeting, accent,
            title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
            rate_limit_per_ip, daily_token_cap, created_by, created_at
     FROM   mcp_public_widgets
     ORDER  BY id`,
  );
  return rows;
}

export async function getWidget(pool: pg.Pool, id: number): Promise<PublicWidget | null> {
  const { rows } = await pool.query<PublicWidget>(
    `SELECT id, agent_id, slug, allowed_origins, enabled, greeting, accent,
            title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
            rate_limit_per_ip, daily_token_cap, created_by, created_at
       FROM mcp_public_widgets
      WHERE id=$1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listPublicWidgetAgents(pool: pg.Pool): Promise<PublicWidgetAgent[]> {
  const { rows } = await pool.query<PublicWidgetAgent>(
    `SELECT id, name, label, enabled, visibility
       FROM mcp_agents
      ORDER BY lower(label), id`,
  );
  return rows;
}

export async function createWidget(
  pool: pg.Pool,
  input: CreateWidgetInput,
): Promise<PublicWidget> {
  const { rows } = await pool.query<PublicWidget>(
    `INSERT INTO mcp_public_widgets
       (agent_id, slug, allowed_origins, enabled, greeting, accent,
        title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
        rate_limit_per_ip, daily_token_cap, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id, agent_id, slug, allowed_origins, enabled, greeting, accent,
               title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
               rate_limit_per_ip, daily_token_cap, created_by, created_at`,
    [
      input.agent_id,
      input.slug,
      input.allowed_origins ?? [],
      input.enabled ?? true,
      input.greeting ?? null,
      input.accent ?? null,
      input.title ?? null,
      input.input_placeholder ?? null,
      input.launcher_icon_url ?? null,
      input.launcher_icon_alt ?? null,
      input.launcher_position ?? 'right',
      input.rate_limit_per_ip ?? 20,
      input.daily_token_cap ?? 50000,
      input.created_by ?? null,
    ],
  );
  return rows[0]!;
}

export async function updateWidget(
  pool: pg.Pool,
  id: number,
  patch: UpdateWidgetInput,
): Promise<PublicWidget> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (patch.agent_id         !== undefined) { sets.push(`agent_id=$${idx++}`);          values.push(patch.agent_id); }
  if (patch.slug             !== undefined) { sets.push(`slug=$${idx++}`);              values.push(patch.slug); }
  if (patch.allowed_origins  !== undefined) { sets.push(`allowed_origins=$${idx++}`);   values.push(patch.allowed_origins); }
  if (patch.enabled          !== undefined) { sets.push(`enabled=$${idx++}`);           values.push(patch.enabled); }
  if (patch.greeting         !== undefined) { sets.push(`greeting=$${idx++}`);          values.push(patch.greeting); }
  if (patch.accent           !== undefined) { sets.push(`accent=$${idx++}`);            values.push(patch.accent); }
  if (patch.title            !== undefined) { sets.push(`title=$${idx++}`);             values.push(patch.title); }
  if (patch.input_placeholder !== undefined){ sets.push(`input_placeholder=$${idx++}`); values.push(patch.input_placeholder); }
  if (patch.launcher_icon_url !== undefined){ sets.push(`launcher_icon_url=$${idx++}`); values.push(patch.launcher_icon_url); }
  if (patch.launcher_icon_alt !== undefined){ sets.push(`launcher_icon_alt=$${idx++}`); values.push(patch.launcher_icon_alt); }
  if (patch.launcher_position !== undefined){ sets.push(`launcher_position=$${idx++}`); values.push(patch.launcher_position); }
  if (patch.rate_limit_per_ip !== undefined){ sets.push(`rate_limit_per_ip=$${idx++}`); values.push(patch.rate_limit_per_ip); }
  if (patch.daily_token_cap  !== undefined) { sets.push(`daily_token_cap=$${idx++}`);   values.push(patch.daily_token_cap); }

  if (sets.length === 0) {
    const { rows } = await pool.query<PublicWidget>(
      `SELECT id, agent_id, slug, allowed_origins, enabled, greeting, accent,
              title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
              rate_limit_per_ip, daily_token_cap, created_by, created_at
       FROM   mcp_public_widgets WHERE id=$1`,
      [id],
    );
    if (!rows[0]) throw new Error(`Widget ${id} not found`);
    return rows[0];
  }

  values.push(id);
  const { rows } = await pool.query<PublicWidget>(
    `UPDATE mcp_public_widgets SET ${sets.join(', ')} WHERE id=$${idx}
     RETURNING id, agent_id, slug, allowed_origins, enabled, greeting, accent,
               title, input_placeholder, launcher_icon_url, launcher_icon_alt, launcher_position,
               rate_limit_per_ip, daily_token_cap, created_by, created_at`,
    values,
  );
  if (!rows[0]) throw new Error(`Widget ${id} not found`);
  return rows[0];
}

export async function deleteWidget(pool: pg.Pool, id: number): Promise<void> {
  const { rowCount } = await pool.query(
    'DELETE FROM mcp_public_widgets WHERE id=$1',
    [id],
  );
  if (rowCount === 0) throw new Error(`Widget ${id} not found`);
}
