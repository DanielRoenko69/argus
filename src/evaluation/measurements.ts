import type { ChatCompletionResponse } from '../llm/types.js';
import { redactJson } from '../lib/redaction.js';

export interface EvaluationMeasurements {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  usage_source: 'provider' | 'partial_provider' | 'unknown';
  cost_source: 'catalog_estimate' | 'unknown';
  provider_model: string | null;
  latency_ms: number;
}
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
const price = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function measureEvaluationResponse(
  response: (Pick<ChatCompletionResponse,'usage'|'usage_observed'> & { model?:string|null }) | undefined,
  latencyMs: number, pricing: Record<string, unknown>,
): EvaluationMeasurements {
  // Anthropic's compatibility response can default omitted fields to zero;
  // its presence-aware side channel preserves what was actually reported.
  const usage = response && Object.hasOwn(response, 'usage_observed') ? response.usage_observed : response?.usage;
  const input = tokens(usage?.prompt_tokens);
  const output = tokens(usage?.completion_tokens);
  const inPrice = price(pricing['input_cost_per_1k']);
  const outPrice = price(pricing['output_cost_per_1k']);
  // Two-rate pricing cannot honestly price cache creation/read discounts.
  const cache = (usage?.cache_creation_input_tokens ?? 0) !== 0 || (usage?.cache_read_input_tokens ?? 0) !== 0
    || ((usage as unknown as Record<string, unknown>)?.['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'];
  const estimate = input !== null && output !== null && inPrice !== null && outPrice !== null && !cache
    ? (input * inPrice + output * outPrice) / 1000 : null;
  const cost = estimate !== null && Number.isFinite(estimate) && estimate < 10000 ? estimate : null;
  return { input_tokens: input, output_tokens: output, cost_usd: cost,
    usage_source: input !== null && output !== null ? 'provider' : input !== null || output !== null ? 'partial_provider' : 'unknown',
    cost_source: cost === null ? 'unknown' : 'catalog_estimate',
    provider_model: typeof response?.model === 'string' ? String(redactJson(response.model.slice(0,240),{ forceEnabled:true }).value) : null,
    latency_ms: Math.max(0, Math.round(latencyMs)) };
}
