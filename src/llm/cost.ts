export function calculateLlmCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPer1k: number | null | undefined,
  outputCostPer1k: number | null | undefined,
): number {
  const inputCost = inputCostPer1k ? (inputTokens / 1000) * inputCostPer1k : 0;
  const outputCost = outputCostPer1k ? (outputTokens / 1000) * outputCostPer1k : 0;
  return Number((inputCost + outputCost).toFixed(8));
}
