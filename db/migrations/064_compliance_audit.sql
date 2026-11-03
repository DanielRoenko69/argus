-- Migration 064: Compliance Audit Agent
-- Three tables for the compliance auditor:
--   mcp_compliance_frameworks  — catalogue of standards (EU AI Act, NIS2, ...)
--   mcp_compliance_runs        — one row per audit execution
--   mcp_compliance_findings    — verdicts per article within a run
--
-- Each framework links to a skill (markdown checklist) and optionally a
-- RAG index containing the standard's full text. The runner reuses the
-- existing reviewer-mode agent pipeline — no new langgraph workflow.

CREATE TABLE IF NOT EXISTS mcp_compliance_frameworks (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,                  -- e.g. 'eu_ai_act'
  label           TEXT NOT NULL,                         -- 'EU AI Act'
  version         TEXT NOT NULL DEFAULT '1',             -- 2024/1689
  jurisdiction    TEXT,                                  -- EU / US / INT
  skill_id        INTEGER REFERENCES mcp_skills(id)      ON DELETE SET NULL,
  rag_index_id    INTEGER REFERENCES mcp_rag_indexes(id) ON DELETE SET NULL,
  description     TEXT NOT NULL DEFAULT '',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_compliance_runs (
  id              SERIAL PRIMARY KEY,
  framework_id    INTEGER NOT NULL REFERENCES mcp_compliance_frameworks(id) ON DELETE CASCADE,
  target          TEXT NOT NULL,                         -- e.g. 'argus' or '/workspace/argus'
  agent_id        INTEGER REFERENCES mcp_agents(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  score           NUMERIC(5,2),                          -- 0..100
  passed_count    INTEGER NOT NULL DEFAULT 0,
  warning_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  na_count        INTEGER NOT NULL DEFAULT 0,
  triggered_by    TEXT,                                  -- username from session
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS ix_compliance_runs_fw_started
  ON mcp_compliance_runs (framework_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_compliance_runs_status
  ON mcp_compliance_runs (status)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS mcp_compliance_findings (
  id              BIGSERIAL PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES mcp_compliance_runs(id) ON DELETE CASCADE,
  article         TEXT NOT NULL,                         -- 'Art. 9' / 'A.5.1' / 'CC1.1'
  title           TEXT NOT NULL,
  verdict         TEXT NOT NULL
    CHECK (verdict IN ('passed','warning','failed','not_applicable')),
  severity        TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low','medium','high','critical')),
  evidence        TEXT,                                  -- agent reasoning
  code_pointers   JSONB NOT NULL DEFAULT '[]',           -- [{file,line,snippet}]
  remediation     TEXT,                                  -- suggested fix
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_compliance_findings_run_verdict
  ON mcp_compliance_findings (run_id, verdict);

-- Framework seed. skill_id + rag_index_id stay NULL until an admin
-- authors the corresponding skill / ingests the standard's full text.
INSERT INTO mcp_compliance_frameworks (slug, label, version, jurisdiction, description) VALUES
  ('eu_ai_act', 'EU AI Act',          '2024/1689', 'EU',  'Regulation 2024/1689 — high-risk AI systems; high-risk requirements effective 2026-08-02'),
  ('nis2',      'NIS2 Directive',     '2022/2555', 'EU',  'Network and information security directive for essential and important entities'),
  ('iso27001',  'ISO/IEC 27001:2022', '2022',      'INT', 'Information security management systems — Annex A controls'),
  ('dora',      'DORA',               '2022/2554', 'EU',  'Digital Operational Resilience Act for the EU financial sector'),
  ('soc2',      'SOC 2 Type II',      '2017 TSC',  'US',  'Trust Services Criteria — Security/Availability/Confidentiality')
ON CONFLICT (slug) DO NOTHING;

COMMENT ON TABLE mcp_compliance_frameworks IS
  'Catalogue of compliance standards. Each framework references one skill (checklist) and optionally a RAG index with the standard full text.';
COMMENT ON TABLE mcp_compliance_runs IS
  'Audit runs. One row per "audit start" click. The agent walks the framework skill article-by-article and writes findings.';
COMMENT ON TABLE mcp_compliance_findings IS
  'Per-article verdicts from a run. code_pointers references actual files/lines in the audited repo.';
