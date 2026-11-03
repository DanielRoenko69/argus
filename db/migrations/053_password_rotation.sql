-- 053: password rotation policy
--
-- Adds `password_changed_at` to mcp_users so we can:
--   1. Show "Last password change: N days ago" in user UI
--   2. Force a password change after PASSWORD_MAX_AGE_DAYS (env var, default 365)
--   3. Compliance: NIS2 / ISO27001 audit trail of password lifecycle
--
-- Backfill: existing users get `created_at` as their last-known change
-- timestamp (best-effort — they'll need to rotate within the configured
-- window, just like new users).

ALTER TABLE mcp_users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

UPDATE mcp_users
   SET password_changed_at = COALESCE(password_changed_at, created_at, now())
 WHERE password_changed_at IS NULL;

ALTER TABLE mcp_users
  ALTER COLUMN password_changed_at SET DEFAULT now(),
  ALTER COLUMN password_changed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_users_password_changed_at
  ON mcp_users (password_changed_at);
