export interface ParamOverrides { temperature?: number; max_tokens?: number; top_p?: number }

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Validate + clamp untrusted request params. Lenient: out-of-range → bounds, junk → dropped. */
export function clampParams(p: unknown): ParamOverrides {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const out: ParamOverrides = {};
  const t = num(o.temperature); if (t !== undefined) out.temperature = clamp(t, 0, 2);
  const tp = num(o.top_p);      if (tp !== undefined) out.top_p = clamp(tp, 0, 1);
  const mt = num(o.max_tokens); if (mt !== undefined) out.max_tokens = clamp(Math.round(mt), 1, 32000);
  return out;
}

/** Merge request overrides over the agent's provider-neutral model defaults. */
export function resolveModelParams(
  agent: { temperature: number | string; max_tokens: number },
  ov?: ParamOverrides,
): { temperature: number; max_tokens: number; top_p?: number } {
  const r: { temperature: number; max_tokens: number; top_p?: number } = {
    temperature: ov?.temperature ?? Number(agent.temperature),
    max_tokens: ov?.max_tokens ?? agent.max_tokens,
  };
  if (ov?.top_p !== undefined) r.top_p = ov.top_p;
  return r;
}
