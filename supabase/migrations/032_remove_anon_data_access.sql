-- 032: no anonymous access to Test Manager data (Phase 0B2).
--
-- Migrations 014/015 (and 017–021, which copied the pattern) gave the anon
-- role SELECT on every data table so Vercel email routes could read without
-- a session when SUPABASE_SERVICE_ROLE_KEY was absent; 007/014 also let anon
-- INSERT email_activity_log. The public anon key ships in the browser
-- bundle, so this made all project data, the audit log and email recipient
-- details readable by anyone — and let anyone forge "already sent" email
-- history, suppressing scheduled emails.
--
-- Nothing depends on it any more (Phase 0B1): the browser reads as the
-- signed-in user, server email / AI settings use the service role and fail
-- closed without it, and the Audit Trail uses the session client.
--
-- This migration drops every anon policy, revokes all anon table
-- privileges (so an anon request is refused outright, not merely filtered
-- to zero rows), stops future tables inheriting anon grants, and revokes
-- TRUNCATE (which bypasses RLS) from anon and authenticated. The
-- authenticated role keeps SELECT/INSERT/UPDATE/DELETE, which RLS (031)
-- governs for the direct browser CRUD the app intentionally retains.

DROP POLICY IF EXISTS "projects_anon_read" ON public.projects;
DROP POLICY IF EXISTS "requirements_anon_read" ON public.requirements;
DROP POLICY IF EXISTS "acceptance_criteria_anon_read" ON public.acceptance_criteria;
DROP POLICY IF EXISTS "test_cases_anon_read" ON public.test_cases;
DROP POLICY IF EXISTS "evidence_anon_read" ON public.evidence;
DROP POLICY IF EXISTS "artefact_links_anon_read" ON public.artefact_links;
DROP POLICY IF EXISTS "req_sign_offs_anon_read" ON public.requirement_sign_offs;
DROP POLICY IF EXISTS "risks_anon_read" ON public.risks;
DROP POLICY IF EXISTS "actions_anon_read" ON public.actions;
DROP POLICY IF EXISTS "decisions_anon_read" ON public.decisions;
DROP POLICY IF EXISTS "dependencies_anon_read" ON public.dependencies;
DROP POLICY IF EXISTS "discovery_questions_anon_read" ON public.discovery_questions;
DROP POLICY IF EXISTS "milestones_anon_read" ON public.milestones;
DROP POLICY IF EXISTS "timeline_items_anon_read" ON public.timeline_items;
DROP POLICY IF EXISTS "deliverables_anon_read" ON public.deliverables;
DROP POLICY IF EXISTS "documents_anon_read" ON public.documents;
DROP POLICY IF EXISTS "meetings_anon_read" ON public.meetings;
DROP POLICY IF EXISTS "project_snapshots_anon_read" ON public.project_snapshots;
DROP POLICY IF EXISTS "activity_log_anon_read" ON public.activity_log;
DROP POLICY IF EXISTS "audit_log_anon_read" ON public.audit_log;
DROP POLICY IF EXISTS "email_settings_anon_read" ON public.email_settings;
DROP POLICY IF EXISTS "email_log_anon_read" ON public.email_activity_log;
DROP POLICY IF EXISTS "email_log_anon_insert" ON public.email_activity_log;
DROP POLICY IF EXISTS "go_live_checklists_anon_read" ON public.go_live_checklists;
DROP POLICY IF EXISTS "cutover_plan_anon_read" ON public.cutover_plan;
DROP POLICY IF EXISTS "anon_read_meeting_intelligence" ON public.meeting_intelligence;
DROP POLICY IF EXISTS "anon_read_meeting_suggestions" ON public.meeting_suggestions;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Tables created later by migrations (owner postgres) must not silently
-- regain anon access or TRUNCATE; they get explicit grants when needed.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM authenticated;
