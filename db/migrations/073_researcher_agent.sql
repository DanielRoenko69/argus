-- Migration 073: Researcher sub-agent + composite
--
-- Creates a chat-mode agent ('researcher') the Coder can spawn via the
-- __call_agent__ tool when it needs to explore a repo before editing.
-- The Researcher reads files / lists directories / greps for patterns
-- and returns a CONCISE summary — context-isolation pattern, per
-- Anthropic's "decouple brain from hands" recommendation.
--
-- Tool scope is intentionally minimal: workspace_read, workspace_ls,
-- and workspace_exec restricted (no write). The Coder keeps full
-- workspace_write — Researcher should never modify files.
--
-- Why a separate composite: the Coder composite has workspace_write +
-- workspace_exec for ANY command. The Researcher MUST NOT, so we gate
-- via composite tool_allow_patterns at the agent level.

INSERT INTO mcp_composites (
  name, description, included_bundle_ids, tool_allow_patterns,
  system_prompt, agent_role, enabled
)
SELECT
  'researcher',
  'Tool scope for Researcher sub-agent — read-only repo exploration',
  ARRAY[]::integer[],
  ARRAY[
    'workspace_read', 'workspace_ls', 'workspace_exec',
    'rag_*'
  ]::text[],
  NULL,
  'researcher',
  true
WHERE NOT EXISTS (SELECT 1 FROM mcp_composites WHERE name = 'researcher');

INSERT INTO mcp_agents (
  name, label, description, model, temperature, max_tokens,
  system_prompt, agent_role, composite_id, enabled, max_iterations,
  agent_mode, risk_level, human_oversight_required
)
SELECT
  'researcher',
  'Researcher',
  'Chat-mode sub-agent that explores a repo on the Coder''s behalf and returns a concise summary. Read-only — cannot modify files. Spawned via __call_agent__ from the Coder when the task needs repo orientation before edits.',
  'gpt-5.1',
  0.2,        -- low temperature → focused, factual summaries
  4000,       -- output is a summary, not a dump
  E'Du bist ein Researcher-Sub-Agent. Deine EINZIGE Aufgabe ist: ' ||
  E'das Repository für den Coder zu explorieren und eine KOMPAKTE ' ||
  E'Zusammenfassung zurückzugeben.' || E'\n\n' ||
  E'## Was du tust' || E'\n' ||
  E'1. Lies die im Auftrag genannten Dateien / Verzeichnisse via workspace_read und workspace_ls.' || E'\n' ||
  E'2. Nutze workspace_exec mit grep / find für spezifische Pattern-Suche.' || E'\n' ||
  E'3. Gib eine strukturierte, kurze Zusammenfassung zurück:' || E'\n' ||
  E'   - Welche Dateien sind relevant?' || E'\n' ||
  E'   - Welche Funktionen / Klassen / Patterns gibt es bereits?' || E'\n' ||
  E'   - Wo sind die wahrscheinlichen Erweiterungspunkte?' || E'\n' ||
  E'   - Welche Konventionen müssen eingehalten werden? (Naming, Test-Layout, …)' || E'\n\n' ||
  E'## Was du NICHT tust' || E'\n' ||
  E'- Niemals Dateien schreiben oder bearbeiten — du hast keine workspace_write Tools.' || E'\n' ||
  E'- Keine Code-Snippets > 30 Zeilen in die Antwort kopieren — zitiere stattdessen Pfad + Funktionsnamen.' || E'\n' ||
  E'- Kein Spekulieren über Implementierungs-Details, die du nicht gesehen hast.' || E'\n' ||
  E'- Maximal 8 Tool-Aufrufe pro Recherche — wenn unklar, frag nach Klarstellung statt mehr Tools zu nutzen.' || E'\n\n' ||
  E'## Output-Format' || E'\n' ||
  E'```' || E'\n' ||
  E'### Relevante Dateien' || E'\n' ||
  E'- path/to/file.py (12 Zeilen) — Modul für X, exportiert handler(), helper()' || E'\n' ||
  E'### Vorhandene Patterns' || E'\n' ||
  E'- ...' || E'\n' ||
  E'### Erweiterungspunkte' || E'\n' ||
  E'- ...' || E'\n' ||
  E'### Konventionen' || E'\n' ||
  E'- ...' || E'\n' ||
  E'```',
  'researcher',
  (SELECT id FROM mcp_composites WHERE name = 'researcher'),
  true,
  8,          -- hard cap matches the "max 8 tools" rule in the system prompt
  'chat',
  'low',
  false
WHERE NOT EXISTS (SELECT 1 FROM mcp_agents WHERE name = 'researcher');
