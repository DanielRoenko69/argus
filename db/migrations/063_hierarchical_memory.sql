-- Migration 063: Hierarchical memory + time validity
--
-- Extends mcp_agent_memory with four memory kinds and validity windows
-- so we can model the Mem0/Zep-style distinction between long-lived
-- facts (semantic, procedural), bounded events (episodic), and
-- session-scoped scratch (working).
--
-- Existing rows: memory_type='fact' is remapped to 'semantic' so the
-- old default lines up with the new taxonomy.

ALTER TABLE mcp_agent_memory
  ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Remap legacy 'fact' values to 'semantic' before tightening the type
-- column. This is idempotent: if a re-run sees no 'fact' rows, nothing
-- happens.
UPDATE mcp_agent_memory SET memory_type = 'semantic' WHERE memory_type = 'fact';

-- Drop the previous (un-constrained) default and pin both the default
-- and the allowed values to the new taxonomy.
ALTER TABLE mcp_agent_memory
  ALTER COLUMN memory_type SET DEFAULT 'semantic';

-- Drop any earlier CHECK constraint on memory_type (older deployments
-- may have a constraint named differently — we don't know, hence the
-- best-effort DO block).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'mcp_agent_memory'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%memory_type%'
  LOOP
    EXECUTE format('ALTER TABLE mcp_agent_memory DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE mcp_agent_memory
  ADD CONSTRAINT mcp_agent_memory_kind_check
  CHECK (memory_type IN ('working', 'episodic', 'semantic', 'procedural'));

-- Indexes: kind+validity for retrieve filters, session_id for working-set lookups.
CREATE INDEX IF NOT EXISTS ix_mcp_agent_memory_kind
  ON mcp_agent_memory (agent_id, memory_type, valid_until);
CREATE INDEX IF NOT EXISTS ix_mcp_agent_memory_session_working
  ON mcp_agent_memory (session_id)
  WHERE memory_type = 'working';
CREATE INDEX IF NOT EXISTS ix_mcp_agent_memory_expire
  ON mcp_agent_memory (valid_until)
  WHERE valid_until IS NOT NULL;

COMMENT ON COLUMN mcp_agent_memory.memory_type IS
  'Memory kind: working (session-scoped scratch), episodic (time-bound event), semantic (persistent fact), procedural (learned preference)';
COMMENT ON COLUMN mcp_agent_memory.valid_from IS
  'When the fact started being true (defaults to insertion time)';
COMMENT ON COLUMN mcp_agent_memory.valid_until IS
  'When the fact stops being true. NULL = no expiry. Used to age out episodic memories.';
