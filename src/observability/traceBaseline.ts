export interface HistoricalTraceWindow {
  days: 7 | 30;
  sampleCount: number;
  terminalCount: number;
  medianDurationMs: number;
  p95DurationMs: number;
  medianCostUsd: number;
  p95CostUsd: number;
  successRate: number;
}

export interface HistoricalTraceBaselineAssessment {
  selectedWindowDays: 7 | 30 | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  sampleCount: number;
  currentDurationMs: number;
  currentCostUsd: number;
  durationDeltaPercent: number | null;
  costDeltaPercent: number | null;
  durationState: 'no_data' | 'normal' | 'warning' | 'critical';
  costState: 'no_data' | 'normal' | 'warning' | 'critical';
  selected: HistoricalTraceWindow | null;
  windows: HistoricalTraceWindow[];
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function deltaPercent(current: number, baseline: number): number | null {
  return baseline > 0 ? 100 * (current - baseline) / baseline : null;
}

function performanceState(
  current: number,
  median: number,
  p95: number,
): HistoricalTraceBaselineAssessment['durationState'] {
  if (median <= 0 && p95 <= 0) return 'no_data';
  if (current > p95 * 1.25 && current > median * 1.5) return 'critical';
  if (current > p95 && current > median * 1.2) return 'warning';
  return 'normal';
}

export function assessHistoricalTraceBaseline(
  current: { durationMs: number; costUsd: number },
  windows: HistoricalTraceWindow[],
): HistoricalTraceBaselineAssessment {
  const sevenDays = windows.find(window => window.days === 7) ?? null;
  const thirtyDays = windows.find(window => window.days === 30) ?? null;
  const selected = sevenDays && sevenDays.sampleCount >= 10
    ? sevenDays
    : thirtyDays && thirtyDays.sampleCount >= 10
      ? thirtyDays
      : [sevenDays, thirtyDays]
        .filter((window): window is HistoricalTraceWindow => window != null && window.sampleCount > 0)
        .sort((left, right) => right.sampleCount - left.sampleCount)[0] ?? null;
  const sampleCount = selected?.sampleCount ?? 0;
  const confidence = sampleCount >= 30 ? 'high' : sampleCount >= 10 ? 'medium' : sampleCount > 0 ? 'low' : 'none';
  const currentDurationMs = finite(current.durationMs);
  const currentCostUsd = finite(current.costUsd);
  return {
    selectedWindowDays: selected?.days ?? null,
    confidence,
    sampleCount,
    currentDurationMs,
    currentCostUsd,
    durationDeltaPercent: selected ? deltaPercent(currentDurationMs, selected.medianDurationMs) : null,
    costDeltaPercent: selected ? deltaPercent(currentCostUsd, selected.medianCostUsd) : null,
    durationState: selected ? performanceState(currentDurationMs, selected.medianDurationMs, selected.p95DurationMs) : 'no_data',
    costState: selected ? performanceState(currentCostUsd, selected.medianCostUsd, selected.p95CostUsd) : 'no_data',
    selected,
    windows: [sevenDays, thirtyDays].filter((window): window is HistoricalTraceWindow => window != null),
  };
}
