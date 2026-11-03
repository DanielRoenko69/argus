/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * Standard-RAG sucht das Embedding der User-Query. Schwach wenn die Query
 * sehr kurz / sparse ist (z.B. "vacation policy"). HyDE generiert eine
 * vollständig formulierte fiktive Antwort und sucht *deren* Embedding —
 * trifft semantisch ähnliche reale Dokumente besser.
 *
 * Trade-Off: +200-500 Tokens pro Query, +~500ms Latenz, dafür spürbar
 * besserer Recall. Konfigurierbar pro RAG-Index (mcp_rag_indexes.hyde_enabled).
 * Default-Modell + Prompt-Template via Platform-Config (/admin/platform-config).
 */

import { getHydeConfig } from '../lib/platformConfig.js';
import { logger } from '../lib/logger.js';
import { chatCompletion, firstText } from '../llm/client.js';

const TIMEOUT_MS = 8_000;

/**
 * Generate a hypothetical answer document for the given query.
 * Returns the generated text, or null on failure (caller should fall back
 * to original query — HyDE is best-effort, never blocking).
 */
export async function generateHypotheticalDoc(query: string): Promise<string | null> {
  const cfg = getHydeConfig();
  const prompt = cfg.prompt.replace('{query}', query);

  try {
    const data = await chatCompletion({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: cfg.maxTokens,
      temperature: 0.7,
    }, { timeoutMs: TIMEOUT_MS });
    const text = firstText(data).trim();
    if (!text) return null;
    return text;
  } catch (err) {
    logger.warn({ err: String(err), model: cfg.model }, 'HyDE generation failed');
    return null;
  }
}
