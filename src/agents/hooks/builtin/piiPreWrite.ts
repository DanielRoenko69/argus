import type { ToolHook } from '../types.js';
import { detectPiiMl, piiMlOptsFromConfig } from '../piiMl.js';

// Standalone regex set so this hook can run without DB lookups.
// Argus has a richer detector in src/lib/redaction.ts which is DB-configured
// — that one is used for LLM-level masking. This hook is the tool-level
// safety net for writes specifically and should be a fast, no-IO check.
const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'email',                   re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'credit-card (16-digit)',  re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'IBAN',                    re: /\b[A-Z]{2}\d{2}[ -]?(?:[A-Z0-9][ -]?){11,30}\b/ },
  { name: 'German Steuer-ID',        re: /\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/ },
  { name: 'IPv4 (private OK, public flagged)', re: /\b(?!(?:10|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.)(?:\d{1,3}\.){3}\d{1,3}\b/ },
];

const WRITE_TOOLS = new Set(['workspace_write', 'workspace_edit', 'gitea_create_pr_comment', 'jira_add_comment', 'confluence_create_page', 'confluence_update_page']);

const CONTENT_KEYS = ['content', 'new_text', 'body', 'text', 'comment', 'message', 'description'];

export const piiPreWriteGuard: ToolHook = {
  name: 'pii-pre-write-guard',
  priority: 110, // right after destructive-cmd-guard
  description: 'Blocks writes (workspace_write, workspace_edit, jira_add_comment, gitea_create_pr_comment, confluence_*) whose content contains detectable PII (email, CC, IBAN, Steuer-ID, public IPv4).',
  async preToolUse(ctx) {
    if (!WRITE_TOOLS.has(ctx.toolName)) return null;

    // Find the first arg key that smells like text content
    let text = '';
    for (const k of CONTENT_KEYS) {
      const v = ctx.toolArgs?.[k];
      if (typeof v === 'string' && v.length > 0) { text = v; break; }
    }
    if (!text) return null;

    // Regex floor — always on, no I/O.
    for (const p of PII_PATTERNS) {
      if (p.re.test(text)) {
        return {
          block: `PII detected in ${ctx.toolName} content: pattern "${p.name}" matched. ` +
                 `Mask or remove the sensitive data before retrying. If you believe this is a ` +
                 `false positive, ask the human reviewer to allowlist the value.`,
        };
      }
    }

    // ML/NER stage (P2.1) — opt-in (PII_ML_ENABLED). Adds context-aware
    // detections (names, locations, …) the regex floor can't catch. Graceful:
    // a Presidio outage returns [] and never blocks — regex above stays the floor.
    const piiOpts = piiMlOptsFromConfig();
    if (piiOpts.enabled) {
      const found = await detectPiiMl(text, piiOpts);
      if (found.length > 0) {
        return {
          block: `PII detected (ML) in ${ctx.toolName} content: ${found.join(', ')}. ` +
                 `Mask or remove the sensitive data before retrying. If you believe this is a ` +
                 `false positive, ask the human reviewer to allowlist the value.`,
        };
      }
    }
    return null;
  },
};
