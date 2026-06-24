-- ============================================================
-- 009_audit_trail.sql  —  Comprehensive Audit Trail
-- ============================================================
-- Tracks who changed what, when, and to what value across all
-- project-critical entities.
--
-- Design principles:
--   • One row per changed field (normalised — enables field-level queries)
--   • CREATE / DELETE produce one summary row (field_name IS NULL)
--   • project_id denormalised for fast per-project queries
--   • changed_by / changed_by_name captured at write time
--   • Table is append-only — no updates, no deletes
-- ============================================================

-- ------------------------------------------------------------
-- 1. audit_log table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        REFERENCES projects(id) ON DELETE SET NULL,
  entity_type      text        NOT NULL,
  entity_id        uuid        NOT NULL,
  entity_name      text        NOT NULL DEFAULT '',
  action_type      text        NOT NULL
                               CHECK (action_type IN (
                                 'Create', 'Update', 'Delete',
                                 'Status Change', 'Health Change', 'Date Change',
                                 'Severity Change', 'Progress Change', 'Schedule Change'
                               )),
  field_name       text,
  old_value        text,
  new_value        text,
  changed_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_name  text        NOT NULL DEFAULT '',
  changed_at       timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. Indexes for common query patterns
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_project      ON audit_log (project_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity       ON audit_log (entity_type, entity_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at   ON audit_log (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_type  ON audit_log (action_type, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_changed_by   ON audit_log (changed_by, changed_at DESC);

-- ------------------------------------------------------------
-- 3. RLS
-- ------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Admin: full read; anyone can insert (the service inserts on behalf of users)
DROP POLICY IF EXISTS "audit_admin_select" ON audit_log;
DROP POLICY IF EXISTS "audit_manager_select" ON audit_log;
DROP POLICY IF EXISTS "audit_insert" ON audit_log;

CREATE POLICY "audit_admin_select"
  ON audit_log FOR SELECT
  USING (get_user_role() = 'Admin');

CREATE POLICY "audit_manager_select"
  ON audit_log FOR SELECT
  USING (get_user_role() = 'Manager');

-- Allow any authenticated user to insert (audit happens client-side)
CREATE POLICY "audit_insert"
  ON audit_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ------------------------------------------------------------
-- 4. Retention helper (optional — call monthly via cron)
-- ------------------------------------------------------------
-- DELETE FROM audit_log WHERE changed_at < now() - INTERVAL '2 years';

-- ------------------------------------------------------------
-- NOTES FOR SYSTEM HEALTH VALIDATION
-- audit_log is intentionally excluded from the loadData() bulk
-- fetch.  System Health checks it separately via a COUNT query.
-- ------------------------------------------------------------
