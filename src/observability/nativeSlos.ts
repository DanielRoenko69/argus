import type pg from 'pg';
import { evaluateNativeAlertMetric, type NativeAlertScopeKind } from './nativeAlerts.js';

export type NativeSloMetric = 'success_rate' | 'p95_latency_ms';
export type NativeSloEvaluationState = 'met' | 'breached' | 'no_data' | 'disabled';

export interface NativeSloInput {
  name: string;
  description?: string;
  metric: NativeSloMetric;
  target: number;
  windowMinutes: number;
  minSamples: number;
  scopeKind: NativeAlertScopeKind;
  scopeValue?: string | null;
  enabled: boolean;
}

export interface NativeSlo extends NativeSloInput {
  id: number;
  description: string;
  scopeValue: string | null;
  createdAt: string;
  updatedAt: string;
  evaluation: {
    state: NativeSloEvaluationState;
    actual: number | null;
    sampleCount: number;
    errorBudgetRemainingPercent: number | null;
    burnRate: number | null;
    evaluatedAt: string;
  };
}

interface NativeSloRow {
  id: number;
  name: string;
  description: string;
  metric: NativeSloMetric;
  target: number | string;
  window_minutes: number;
  min_samples: number;
  scope_kind: NativeAlertScopeKind;
  scope_value: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function mapDefinition(row: NativeSloRow): Omit<NativeSlo, 'evaluation'> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metric: row.metric,
    target: Number(row.target),
    windowMinutes: row.window_minutes,
    minSamples: row.min_samples,
    scopeKind: row.scope_kind,
    scopeValue: row.scope_value,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reliabilityBudget(actual: number, target: number, sampleCount: number): {
  remaining: number;
  burnRate: number;
} {
  const actualFailureRate = Math.max(0, 100 - actual);
  const allowedFailureRate = Math.max(0, 100 - target);
  if (allowedFailureRate === 0) {
    return { remaining: actualFailureRate === 0 ? 100 : 0, burnRate: actualFailureRate === 0 ? 0 : Number.MAX_SAFE_INTEGER };
  }
  const allowedFailures = sampleCount * allowedFailureRate / 100;
  const actualFailures = sampleCount * actualFailureRate / 100;
  return {
    remaining: Math.max(0, Math.min(100, 100 - actualFailures / allowedFailures * 100)),
    burnRate: actualFailureRate / allowedFailureRate,
  };
}

async function evaluateSlo(pool: pg.Pool, definition: Omit<NativeSlo, 'evaluation'>): Promise<NativeSlo> {
  const evaluatedAt = new Date().toISOString();
  if (!definition.enabled) {
    return { ...definition, evaluation: { state: 'disabled', actual: null, sampleCount: 0, errorBudgetRemainingPercent: null, burnRate: null, evaluatedAt } };
  }
  const metric = await evaluateNativeAlertMetric(pool, {
    metric: definition.metric,
    windowMinutes: definition.windowMinutes,
    scopeKind: definition.scopeKind,
    scopeValue: definition.scopeValue,
  });
  const enoughData = metric.sampleCount >= definition.minSamples;
  const met = definition.metric === 'success_rate'
    ? metric.value >= definition.target
    : metric.value <= definition.target;
  const budget = definition.metric === 'success_rate'
    ? reliabilityBudget(metric.value, definition.target, metric.sampleCount)
    : null;
  return {
    ...definition,
    evaluation: {
      state: enoughData ? met ? 'met' : 'breached' : 'no_data',
      actual: metric.value,
      sampleCount: metric.sampleCount,
      errorBudgetRemainingPercent: budget?.remaining ?? null,
      burnRate: budget?.burnRate ?? null,
      evaluatedAt,
    },
  };
}

export async function listNativeSlos(pool: pg.Pool): Promise<NativeSlo[]> {
  const { rows } = await pool.query<NativeSloRow>(
    'SELECT * FROM mcp_observability_slos ORDER BY enabled DESC, updated_at DESC, id DESC',
  );
  const evaluated = await Promise.all(rows.map(row => evaluateSlo(pool, mapDefinition(row))));
  const weight: Record<NativeSloEvaluationState, number> = { breached: 3, no_data: 2, met: 1, disabled: 0 };
  return evaluated.sort((left, right) => weight[right.evaluation.state] - weight[left.evaluation.state] || right.id - left.id);
}

export async function createNativeSlo(pool: pg.Pool, input: NativeSloInput, userId: number): Promise<NativeSlo> {
  const { rows } = await pool.query<NativeSloRow>(
    `INSERT INTO mcp_observability_slos
      (name, description, metric, target, window_minutes, min_samples, scope_kind, scope_value, enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [input.name, input.description ?? '', input.metric, input.target, input.windowMinutes, input.minSamples,
      input.scopeKind, input.scopeValue || null, input.enabled, userId],
  );
  return evaluateSlo(pool, mapDefinition(rows[0]!));
}

export async function updateNativeSlo(pool: pg.Pool, id: number, input: NativeSloInput): Promise<NativeSlo | null> {
  const { rows } = await pool.query<NativeSloRow>(
    `UPDATE mcp_observability_slos
        SET name=$2, description=$3, metric=$4, target=$5, window_minutes=$6,
            min_samples=$7, scope_kind=$8, scope_value=$9, enabled=$10, updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [id, input.name, input.description ?? '', input.metric, input.target, input.windowMinutes,
      input.minSamples, input.scopeKind, input.scopeValue || null, input.enabled],
  );
  return rows[0] ? evaluateSlo(pool, mapDefinition(rows[0])) : null;
}

export async function deleteNativeSlo(pool: pg.Pool, id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM mcp_observability_slos WHERE id=$1', [id]);
  return (result.rowCount ?? 0) > 0;
}
