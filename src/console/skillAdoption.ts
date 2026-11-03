import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface SkillAdoptionResponse {
  generatedAt: string;
  windowDays: number;
  kpis: {
    activeConsumers1d: number;
    activeConsumers7d: number;
    activeConsumers30d: number;
    totalSkills: number;
    activeSkills: number;
    adoptionRate: number;
    totalUses: number;
    averageUsesPerConsumer: number;
    p50Ms: number;
    p95Ms: number;
    errorCount: number;
    errorRate: number;
  };
  bySkill: Array<{
    skill: string;
    label: string;
    uses: number;
    activeConsumers: number;
    averageContextLength: number;
    p95Ms: number;
    errorCount: number;
    errorRate: number;
  }>;
  consumers: Array<{
    id: string;
    skillFetches: number;
    distinctSkills: number;
  }>;
  timeSeries: Array<{ day: string; uses: number; errors: number }>;
  stale: Array<{
    id: number;
    name: string;
    label: string;
    icon: string;
    daysSinceLastUse: number | null;
  }>;
  trending: Array<{
    skill: string;
    label: string;
    recent: number;
    prior: number;
    delta: number;
  }>;
  heatmap: Array<{ dayOfWeek: number; hour: number; uses: number }>;
}

type SkillUsageRow = {
  skill: string;
  label: string | null;
  uses: number;
  unique_consumers: number;
  avg_ctx_len: number;
  p95_ms: number;
  error_count: number;
};
type ConsumerRow = { api_key_prefix: string | null; skill_fetches: number; distinct_skills: number };
type TimeSeriesRow = { day: string; uses: number; errors: number };
type KpiRow = {
  dau: number; wau: number; mau: number; total_skills: number; active_skills: number;
  total_uses: number; avg_fetches_per_user: number; p50_ms: number; p95_ms: number; error_count: number;
};
type StaleRow = {
  id: number; name: string; label: string; icon: string; days_since_last_use: number | string | null;
};
type TrendingRow = { skill: string; label: string | null; recent: number; prior: number; delta: number };
type HeatmapRow = { dow: number; hour: number; n: number };

export function normalizeSkillAdoptionDays(value: unknown): number {
  if (value == null || value === '') return 30;
  const raw = String(value);
  if (!/^\d{1,2}$/.test(raw)) throw new Error('Adoption window must be a whole number from 1 to 90 days');
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new Error('Adoption window must be a whole number from 1 to 90 days');
  }
  return days;
}

function number(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1_000) / 10 : 0;
}

function consumerId(prefix: string | null): string {
  const stable = prefix?.trim() || 'anonymous-runtime';
  return `runtime-${createHash('sha256').update(stable).digest('hex').slice(0, 8)}`;
}

function completeTimeSeries(rows: TimeSeriesRow[], days: number, now = new Date()): SkillAdoptionResponse['timeSeries'] {
  const observed = new Map(rows.map(row => [row.day, { uses: number(row.uses), errors: number(row.errors) }]));
  const result: SkillAdoptionResponse['timeSeries'] = [];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(end.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    result.push({ day, ...(observed.get(day) ?? { uses: 0, errors: 0 }) });
  }
  return result;
}

export function buildSkillAdoptionResponse(
  days: number,
  rows: {
    bySkill: SkillUsageRow[];
    consumers: ConsumerRow[];
    timeSeries: TimeSeriesRow[];
    kpi: KpiRow | null;
    stale: StaleRow[];
    trending: TrendingRow[];
    heatmap: HeatmapRow[];
  },
  now = new Date(),
): SkillAdoptionResponse {
  const kpi = rows.kpi;
  const totalUses = number(kpi?.total_uses);
  const errorCount = number(kpi?.error_count);
  const totalSkills = number(kpi?.total_skills);
  const activeSkills = number(kpi?.active_skills);
  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    kpis: {
      activeConsumers1d: number(kpi?.dau),
      activeConsumers7d: number(kpi?.wau),
      activeConsumers30d: number(kpi?.mau),
      totalSkills,
      activeSkills,
      adoptionRate: percentage(activeSkills, totalSkills),
      totalUses,
      averageUsesPerConsumer: number(kpi?.avg_fetches_per_user),
      p50Ms: number(kpi?.p50_ms),
      p95Ms: number(kpi?.p95_ms),
      errorCount,
      errorRate: percentage(errorCount, totalUses),
    },
    bySkill: rows.bySkill.slice(0, 50).map(row => ({
      skill: row.skill,
      label: row.label || row.skill,
      uses: number(row.uses),
      activeConsumers: number(row.unique_consumers),
      averageContextLength: number(row.avg_ctx_len),
      p95Ms: number(row.p95_ms),
      errorCount: number(row.error_count),
      errorRate: percentage(number(row.error_count), number(row.uses)),
    })),
    consumers: rows.consumers.slice(0, 20).map(row => ({
      id: consumerId(row.api_key_prefix),
      skillFetches: number(row.skill_fetches),
      distinctSkills: number(row.distinct_skills),
    })),
    timeSeries: completeTimeSeries(rows.timeSeries, days, now),
    stale: rows.stale.slice(0, 30).map(row => ({
      id: number(row.id),
      name: row.name,
      label: row.label,
      icon: row.icon || '✦',
      daysSinceLastUse: row.days_since_last_use == null ? null : Math.max(0, Math.floor(number(row.days_since_last_use))),
    })),
    trending: rows.trending.slice(0, 20).map(row => ({
      skill: row.skill,
      label: row.label || row.skill,
      recent: number(row.recent),
      prior: number(row.prior),
      delta: number(row.delta),
    })),
    heatmap: rows.heatmap.slice(0, 168).map(row => ({
      dayOfWeek: number(row.dow),
      hour: number(row.hour),
      uses: number(row.n),
    })),
  };
}

export async function loadSkillAdoption(
  pool: pg.Pool,
  days: number,
): Promise<SkillAdoptionResponse> {
  const half = Math.max(1, Math.floor(days / 2));
  const [bySkill, consumers, timeSeries, kpis, stale, trending, heatmap] = await Promise.all([
    pool.query<SkillUsageRow>(
      `SELECT replace(a.tool, 'prompt.skill.', '') AS skill,
              coalesce(s.label, replace(a.tool, 'prompt.skill.', '')) AS label,
              count(*)::int AS uses,
              count(DISTINCT a.api_key_prefix)::int AS unique_consumers,
              coalesce(avg(nullif((a.parameters->>'context_len')::int, 0)), 0)::int AS avg_ctx_len,
              coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms), 0)::int AS p95_ms,
              count(*) FILTER (WHERE a.is_error)::int AS error_count
         FROM mcp_audit_log a
         LEFT JOIN mcp_skills s ON a.tool = 'prompt.skill.' || s.name
        WHERE a.tool LIKE 'prompt.skill.%'
          AND a.timestamp > now() - make_interval(days => $1)
        GROUP BY a.tool, s.label
        ORDER BY uses DESC
        LIMIT 50`,
      [days],
    ),
    pool.query<ConsumerRow>(
      `SELECT api_key_prefix,
              count(*)::int AS skill_fetches,
              count(DISTINCT tool)::int AS distinct_skills
         FROM mcp_audit_log
        WHERE tool LIKE 'prompt.skill.%'
          AND timestamp > now() - make_interval(days => $1)
        GROUP BY api_key_prefix
        ORDER BY skill_fetches DESC
        LIMIT 20`,
      [days],
    ),
    pool.query<TimeSeriesRow>(
      `SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day,
              count(*)::int AS uses,
              count(*) FILTER (WHERE is_error)::int AS errors
         FROM mcp_audit_log
        WHERE tool LIKE 'prompt.skill.%'
          AND timestamp > now() - make_interval(days => $1)
        GROUP BY date_trunc('day', timestamp)
        ORDER BY day`,
      [days],
    ),
    pool.query<KpiRow>(
      `WITH win AS (
         SELECT * FROM mcp_audit_log
          WHERE tool LIKE 'prompt.skill.%'
            AND timestamp > now() - make_interval(days => $1)
       )
       SELECT
         (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > now() - interval '1 day') AS dau,
         (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > now() - interval '7 days') AS wau,
         (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > now() - interval '30 days') AS mau,
         (SELECT count(*)::int FROM mcp_skills) AS total_skills,
         count(DISTINCT tool)::int AS active_skills,
         count(*)::int AS total_uses,
         CASE WHEN count(DISTINCT api_key_prefix) = 0 THEN 0
              ELSE round(count(*)::numeric / count(DISTINCT api_key_prefix), 1)
          END::float8 AS avg_fetches_per_user,
         coalesce(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
         coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
         count(*) FILTER (WHERE is_error)::int AS error_count
         FROM win`,
      [days],
    ),
    pool.query<StaleRow>(
      `SELECT s.id, s.name, s.label, s.icon,
              extract(epoch FROM (now() - max(a.timestamp))) / 86400.0 AS days_since_last_use
         FROM mcp_skills s
         LEFT JOIN mcp_audit_log a ON a.tool = 'prompt.skill.' || s.name
        GROUP BY s.id, s.name, s.label, s.icon
       HAVING max(a.timestamp) IS NULL OR max(a.timestamp) < now() - make_interval(days => $1)
        ORDER BY days_since_last_use DESC NULLS FIRST, s.label
        LIMIT 30`,
      [days],
    ),
    pool.query<TrendingRow>(
      `WITH recent AS (
         SELECT tool, count(*) AS n FROM mcp_audit_log
          WHERE tool LIKE 'prompt.skill.%'
            AND timestamp > now() - make_interval(days => $1)
          GROUP BY tool
       ), prior AS (
         SELECT tool, count(*) AS n FROM mcp_audit_log
          WHERE tool LIKE 'prompt.skill.%'
            AND timestamp BETWEEN now() - make_interval(days => $1 * 2)
                              AND now() - make_interval(days => $1)
          GROUP BY tool
       )
       SELECT replace(coalesce(r.tool, p.tool), 'prompt.skill.', '') AS skill,
              s.label,
              coalesce(r.n, 0)::int AS recent,
              coalesce(p.n, 0)::int AS prior,
              (coalesce(r.n, 0) - coalesce(p.n, 0))::int AS delta
         FROM recent r
         FULL OUTER JOIN prior p ON r.tool = p.tool
         LEFT JOIN mcp_skills s ON coalesce(r.tool, p.tool) = 'prompt.skill.' || s.name
        ORDER BY abs(coalesce(r.n, 0) - coalesce(p.n, 0)) DESC, recent DESC
        LIMIT 20`,
      [half],
    ),
    pool.query<HeatmapRow>(
      `SELECT extract(dow FROM timestamp)::int AS dow,
              extract(hour FROM timestamp)::int AS hour,
              count(*)::int AS n
         FROM mcp_audit_log
        WHERE tool LIKE 'prompt.skill.%'
          AND timestamp > now() - make_interval(days => $1)
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [days],
    ),
  ]);

  return buildSkillAdoptionResponse(days, {
    bySkill: bySkill.rows,
    consumers: consumers.rows,
    timeSeries: timeSeries.rows,
    kpi: kpis.rows[0] ?? null,
    stale: stale.rows,
    trending: trending.rows,
    heatmap: heatmap.rows,
  });
}
