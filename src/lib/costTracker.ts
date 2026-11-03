import { logger } from './logger.js';

// Rough estimate: ~4 characters per token for English text / JSON
const CHARS_PER_TOKEN = 4;

interface UsageRecord {
  apiKeyPrefix: string;
  tool: string;
  estimatedTokens: number;
  timestamp: number;
}

const usageLog: UsageRecord[] = [];

export function trackUsage(apiKeyPrefix: string, tool: string, resultText: string): void {
  const estimatedTokens = Math.ceil(resultText.length / CHARS_PER_TOKEN);
  usageLog.push({
    apiKeyPrefix,
    tool,
    estimatedTokens,
    timestamp: Date.now(),
  });

  // Keep only last 24h of records in memory
  const cutoff = Date.now() - 86_400_000;
  while (usageLog.length > 0 && usageLog[0].timestamp < cutoff) {
    usageLog.shift();
  }
}

export interface UsageSummary {
  totalTokens: number;
  byApiKey: Record<string, number>;
  byTool: Record<string, number>;
  recordCount: number;
  periodHours: number;
}

export function getUsageSummary(hours: number = 24): UsageSummary {
  const cutoff = Date.now() - hours * 3_600_000;
  const relevant = usageLog.filter(r => r.timestamp >= cutoff);

  const byApiKey: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  let totalTokens = 0;

  for (const r of relevant) {
    totalTokens += r.estimatedTokens;
    byApiKey[r.apiKeyPrefix] = (byApiKey[r.apiKeyPrefix] ?? 0) + r.estimatedTokens;
    byTool[r.tool] = (byTool[r.tool] ?? 0) + r.estimatedTokens;
  }

  return { totalTokens, byApiKey, byTool, recordCount: relevant.length, periodHours: hours };
}

export function logUsageSummary(): void {
  const summary = getUsageSummary(1);
  if (summary.recordCount > 0) {
    logger.info({ ...summary, periodHours: 1 }, 'Hourly usage summary');
  }
}
