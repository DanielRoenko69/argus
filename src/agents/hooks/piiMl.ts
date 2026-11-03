/**
 * ML-based PII detection (P2.1) — opt-in NER layer that augments the regex
 * floor in pii-pre-write-guard. Calls a self-hosted Microsoft Presidio analyzer
 * (no data leaves the boundary — sovereignty-aligned). Opt-in via
 * PII_ML_ENABLED; the Presidio container is a docker-compose `pii`
 * profile service.
 *
 * GRACEFUL BY DESIGN: any failure (disabled, unreachable, timeout, bad response)
 * returns [] so a PII-service outage NEVER blocks a write — the regex layer in
 * pii-pre-write-guard remains the always-on floor. The ML layer can only ADD
 * detections (tighten-only), never weaken the regex floor.
 */
import { logger } from '../../lib/logger.js';
import { loadConfig } from '../../config/env.js';

export interface PiiMlOpts {
  enabled: boolean;
  url: string;        // Presidio analyzer base URL
  threshold: number;  // minimum entity score to flag
  entities: string[]; // entity types to flag ([] = any type Presidio returns)
  language: string;
}

export type PiiFetch = typeof fetch;

interface PresidioEntity { entity_type: string; score: number; start: number; end: number; }

/**
 * Build opts from central config (env). Kept separate so detectPiiMl stays
 * pure/testable. Guarded: if config can't be loaded (e.g. a minimal test env
 * where loadConfig's required-var validation throws), ML is simply OFF — the
 * regex floor in pii-pre-write-guard is unaffected.
 */
export function piiMlOptsFromConfig(): PiiMlOpts {
  try {
    const c = loadConfig();
    return {
      enabled: c.piiMlEnabled,
      url: c.piiMlUrl,
      threshold: c.piiMlThreshold,
      entities: c.piiMlEntities,
      language: c.piiMlLanguage,
    };
  } catch {
    return { enabled: false, url: '', threshold: 0.6, entities: [], language: 'en' };
  }
}

/**
 * Returns the distinct PII entity types Presidio found at/above the threshold.
 * Empty array means "no ML-PII" — used for both genuinely-clean text AND any
 * failure (graceful degrade). fetchImpl is injectable for tests.
 */
export async function detectPiiMl(
  text: string,
  opts: PiiMlOpts,
  fetchImpl: PiiFetch = fetch,
): Promise<string[]> {
  if (!opts.enabled || !text) return [];
  try {
    const res = await fetchImpl(`${opts.url.replace(/\/$/, '')}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: opts.language, score_threshold: opts.threshold }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const entities = (await res.json()) as PresidioEntity[];
    if (!Array.isArray(entities)) return [];
    const wanted = opts.entities.length > 0 ? new Set(opts.entities) : null;
    const found = new Set<string>();
    for (const e of entities) {
      if (e && typeof e.score === 'number' && e.score >= opts.threshold && (!wanted || wanted.has(e.entity_type))) {
        found.add(e.entity_type);
      }
    }
    return [...found];
  } catch (err) {
    logger.debug({ err: String(err) }, 'pii-ml: Presidio analyze failed — degrading to regex-only floor');
    return [];
  }
}
