-- 014: Allow server-side (unauthenticated anon) reads of email_settings and
--      email_activity_log so that scheduled email routes can load settings and
--      write activity logs without a user session.
--
-- Context: migration 008 enabled RLS on all tables with policies keyed to
-- get_user_role() = 'Admin'/'Manager'. Vercel cron routes use the anon Supabase
-- client (no auth session), so auth.uid() is null, get_user_role() returns null,
-- and no policy matches — maybeSingle() returns null, causing loadSettings() to
-- fall through to hardcoded defaults (daily_brief_enabled = false).
--
-- Fix: add explicit anon-role read and write policies for these two operational
-- tables. email_settings contains no user PII; email_activity_log is append-only
-- operational data.

-- ── email_settings: allow anon to read ─────────────────────────────────────────
DROP POLICY IF EXISTS "email_settings_anon_read" ON email_settings;
CREATE POLICY "email_settings_anon_read"
  ON email_settings FOR SELECT
  TO anon
  USING (true);

-- ── email_activity_log: allow anon to read and insert ──────────────────────────
-- Cron routes write activity log rows with the anon client (no user session).
DROP POLICY IF EXISTS "email_log_anon_read"   ON email_activity_log;
DROP POLICY IF EXISTS "email_log_anon_insert" ON email_activity_log;

CREATE POLICY "email_log_anon_read"
  ON email_activity_log FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "email_log_anon_insert"
  ON email_activity_log FOR INSERT
  TO anon
  WITH CHECK (true);
