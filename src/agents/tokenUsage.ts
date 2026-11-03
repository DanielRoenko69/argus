import { calculateLlmCost } from '../llm/cost.js';

/** Build the `data: {token_usage:{…}}` SSE line for a completed turn. Cost via
 * direct-provider pricing (null pricing → 0). Returns the full SSE string incl. \n\n. */
export function tokenUsageEvent(
  promptTokens: number,
  completionTokens: number,
  model: string,
  inputCostPer1k: number | null | undefined,
  outputCostPer1k: number | null | undefined,
): string {
  const cost = calculateLlmCost(promptTokens, completionTokens, inputCostPer1k, outputCostPer1k);
  return `data: ${JSON.stringify({
    token_usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cost,
      model,
    },
  })}\n\n`;
}
