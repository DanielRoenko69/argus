-- Migration 095 — Postgres-Trigger blockt UPDATE/DELETE auf mcp_immutable_audit_log.
-- Code-seitig wird die Tabelle bereits append-only behandelt, aber ein kompromittierter
-- DB-User oder ein versehentlicher psql-Befehl könnte sie modifizieren. Dieser Trigger
-- macht die Immutabilität auf DB-Ebene durchsetzbar.
--
-- Notausgang für DB-Admin: SET LOCAL argus.audit_bypass = 'true' in derselben Transaktion.
--
-- Hinweis: Migration 058 hatte RULES `no_update_immutable_audit` / `no_delete_immutable_audit`
-- die UPDATE/DELETE *stillschweigend* (DO INSTEAD NOTHING) verworfen haben. Das ist gefährlich,
-- weil ein Angreifer keinen Fehler sieht und denkt, die Modifikation sei erfolgreich. Wir
-- entfernen die RULES und ersetzen sie durch BEFORE-Trigger, die laute RAISE EXCEPTION werfen.

DROP RULE IF EXISTS no_update_immutable_audit ON mcp_immutable_audit_log;
DROP RULE IF EXISTS no_delete_immutable_audit ON mcp_immutable_audit_log;

CREATE OR REPLACE FUNCTION mcp_immutable_audit_log_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('argus.audit_bypass', true) = 'true' THEN
    -- Bypass audit trail: log to Postgres server log for forensic review.
    -- Pair with log_min_messages='warning' and a log-shipping pipeline (Phase 3).
    RAISE WARNING 'audit_bypass invoked: op=% table=mcp_immutable_audit_log row_id=% session_user=% app=%',
      TG_OP,
      COALESCE(NEW.id, OLD.id),
      session_user,
      current_setting('application_name', true);
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'mcp_immutable_audit_log is append-only (% blocked). '
    'Set argus.audit_bypass=true in same TX to override (logged via RAISE WARNING).',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_immutable_audit_log_no_update ON mcp_immutable_audit_log;
DROP TRIGGER IF EXISTS mcp_immutable_audit_log_no_delete ON mcp_immutable_audit_log;
DROP TRIGGER IF EXISTS mcp_immutable_audit_log_no_truncate ON mcp_immutable_audit_log;

CREATE TRIGGER mcp_immutable_audit_log_no_update
  BEFORE UPDATE ON mcp_immutable_audit_log
  FOR EACH ROW EXECUTE FUNCTION mcp_immutable_audit_log_block_modify();

CREATE TRIGGER mcp_immutable_audit_log_no_delete
  BEFORE DELETE ON mcp_immutable_audit_log
  FOR EACH ROW EXECUTE FUNCTION mcp_immutable_audit_log_block_modify();

CREATE TRIGGER mcp_immutable_audit_log_no_truncate
  BEFORE TRUNCATE ON mcp_immutable_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_immutable_audit_log_block_modify();

COMMENT ON FUNCTION mcp_immutable_audit_log_block_modify() IS
  'Phase-1 sec-härtung 2026-05-27: blocks UPDATE/DELETE/TRUNCATE on audit log unless argus.audit_bypass=true is set in transaction. Bypass usage is logged via RAISE WARNING to Postgres server log (forensic trail).';
