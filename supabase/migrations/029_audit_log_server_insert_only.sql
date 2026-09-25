-- 029: audit_log is written only by the server.
--
-- Migration 009 allowed any session with auth.uid() IS NOT NULL to INSERT
-- audit rows directly. That policy never worked for the app itself (the
-- client audit helper used a session-less anon client, so every insert was
-- rejected and no audit row has been recorded since 2026-06-25), and it
-- would let any signed-in user forge rows with an arbitrary changed_by.
--
-- Audit writes now go exclusively through the authenticated route
-- app/api/audit, which stamps changed_by / changed_by_name from the session
-- and inserts with the service-role client (service_role bypasses RLS). With
-- no INSERT policy left, the anon and authenticated roles can no longer
-- write audit_log at all. Existing rows and the SELECT policies are
-- unchanged; audit_log remains the single, append-only audit table.

DROP POLICY IF EXISTS "audit_insert" ON audit_log;
