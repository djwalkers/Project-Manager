-- 031: role-based RLS for delivery data (Phase 0B2).
--
-- Replaces the legacy policies with one coherent model built on the
-- migration-030 helpers (can_read / can_write / is_admin / app_role):
--
--   Viewer  — SELECT only
--   Manager — SELECT, INSERT, UPDATE, DELETE
--   Admin   — as Manager (plus project DELETE and configuration)
--
-- Before this migration:
--   * "Group A" tables (requirements, test_cases, risks, …): Admin wrote,
--     Manager could only read, Viewer could read nothing — so the UI's
--     Manager edits were refused and Viewers saw an empty dashboard.
--   * "Group B" tables (acceptance_criteria, evidence, artefact_links,
--     requirement_sign_offs, meeting_intelligence, meeting_suggestions):
--     ANY authenticated user (Viewer, or a user with no profile) had full
--     write access.
--
-- All new policies are TO authenticated, so the anon role matches none of
-- them. Helper calls are wrapped as (SELECT …) so Postgres evaluates them
-- once per statement rather than once per row.
--
-- The anon read policies are removed separately in 032. Server-managed
-- tables are untouched here: go_live_readiness_overrides, go_live_decisions
-- (append-only trigger), go_live_checklists, cutover_plan (no
-- authenticated policies — writes only through their Manager/Admin API
-- routes), audit_log (Admin/Manager SELECT only; written by /api/audit),
-- ai_settings and microsoft_tokens (service role only), user_profiles (030).

-- ── Drop the legacy authenticated / role policies ──────────────────────────

DROP POLICY IF EXISTS "requirements_admin" ON public.requirements;
DROP POLICY IF EXISTS "requirements_read" ON public.requirements;
DROP POLICY IF EXISTS "tests_admin" ON public.test_cases;
DROP POLICY IF EXISTS "tests_read" ON public.test_cases;
DROP POLICY IF EXISTS "risks_admin" ON public.risks;
DROP POLICY IF EXISTS "risks_read" ON public.risks;
DROP POLICY IF EXISTS "actions_admin" ON public.actions;
DROP POLICY IF EXISTS "actions_read" ON public.actions;
DROP POLICY IF EXISTS "decisions_admin" ON public.decisions;
DROP POLICY IF EXISTS "decisions_read" ON public.decisions;
DROP POLICY IF EXISTS "dependencies_admin" ON public.dependencies;
DROP POLICY IF EXISTS "dependencies_read" ON public.dependencies;
DROP POLICY IF EXISTS "discovery_admin" ON public.discovery_questions;
DROP POLICY IF EXISTS "discovery_read" ON public.discovery_questions;
DROP POLICY IF EXISTS "milestones_admin" ON public.milestones;
DROP POLICY IF EXISTS "milestones_read" ON public.milestones;
DROP POLICY IF EXISTS "timeline_admin" ON public.timeline_items;
DROP POLICY IF EXISTS "timeline_read" ON public.timeline_items;
DROP POLICY IF EXISTS "deliverables_admin" ON public.deliverables;
DROP POLICY IF EXISTS "deliverables_read" ON public.deliverables;
DROP POLICY IF EXISTS "documents_admin" ON public.documents;
DROP POLICY IF EXISTS "documents_read" ON public.documents;
DROP POLICY IF EXISTS "meetings_admin" ON public.meetings;
DROP POLICY IF EXISTS "meetings_read" ON public.meetings;
DROP POLICY IF EXISTS "activity_admin" ON public.activity_log;
DROP POLICY IF EXISTS "activity_read" ON public.activity_log;
DROP POLICY IF EXISTS "snapshots_admin" ON public.project_snapshots;
DROP POLICY IF EXISTS "snapshots_read" ON public.project_snapshots;

DROP POLICY IF EXISTS "acceptance_criteria_auth_all" ON public.acceptance_criteria;
DROP POLICY IF EXISTS "evidence_auth_all" ON public.evidence;
DROP POLICY IF EXISTS "artefact_links_auth_all" ON public.artefact_links;
DROP POLICY IF EXISTS "req_sign_offs_auth_all" ON public.requirement_sign_offs;
DROP POLICY IF EXISTS "auth_all_meeting_intelligence" ON public.meeting_intelligence;
DROP POLICY IF EXISTS "auth_all_meeting_suggestions" ON public.meeting_suggestions;
-- Redundant: service_role has BYPASSRLS, so these never took effect.
DROP POLICY IF EXISTS "service_all_meeting_intelligence" ON public.meeting_intelligence;
DROP POLICY IF EXISTS "service_all_meeting_suggestions" ON public.meeting_suggestions;

DROP POLICY IF EXISTS "projects_admin" ON public.projects;
DROP POLICY IF EXISTS "projects_read" ON public.projects;

DROP POLICY IF EXISTS "email_settings_admin" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings_read" ON public.email_settings;
DROP POLICY IF EXISTS "email_log_admin" ON public.email_activity_log;
DROP POLICY IF EXISTS "email_log_read" ON public.email_activity_log;

-- ── Delivery tables: Viewer reads; Manager/Admin write ─────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'requirements', 'test_cases', 'risks', 'actions', 'decisions', 'dependencies',
    'discovery_questions', 'milestones', 'timeline_items', 'deliverables', 'documents',
    'meetings', 'activity_log', 'project_snapshots',
    'acceptance_criteria', 'evidence', 'artefact_links', 'requirement_sign_offs',
    'meeting_intelligence', 'meeting_suggestions'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.can_read()))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.can_write()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.can_write())) WITH CHECK ((SELECT public.can_write()))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT public.can_write()))', t || '_delete', t);
  END LOOP;
END
$$;

-- ── Projects ───────────────────────────────────────────────────────────────
-- No INSERT policy: projects are created only through POST /api/projects
-- (Manager/Admin check, validation, service-role insert). Edit: Manager/
-- Admin. Delete (cascades to the project's records): Admin only.

DROP POLICY IF EXISTS "projects_select" ON public.projects;
DROP POLICY IF EXISTS "projects_update" ON public.projects;
DROP POLICY IF EXISTS "projects_delete" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT TO authenticated USING ((SELECT public.can_read()));
CREATE POLICY "projects_update" ON public.projects FOR UPDATE TO authenticated USING ((SELECT public.can_write())) WITH CHECK ((SELECT public.can_write()));
CREATE POLICY "projects_delete" ON public.projects FOR DELETE TO authenticated USING ((SELECT public.is_admin()));

-- ── Email configuration and history ───────────────────────────────────────
-- Settings: Manager/Admin read (System Health, Manager Summary); only Admin
-- configures. Activity: Manager/Admin read; written only by the server
-- (service role) — no API-user write at all.

DROP POLICY IF EXISTS "email_settings_select" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings_insert" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings_update" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings_delete" ON public.email_settings;
CREATE POLICY "email_settings_select" ON public.email_settings FOR SELECT TO authenticated USING ((SELECT public.app_role()) IN ('Admin', 'Manager'));
CREATE POLICY "email_settings_insert" ON public.email_settings FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_admin()));
CREATE POLICY "email_settings_update" ON public.email_settings FOR UPDATE TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
CREATE POLICY "email_settings_delete" ON public.email_settings FOR DELETE TO authenticated USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "email_activity_log_select" ON public.email_activity_log;
CREATE POLICY "email_activity_log_select" ON public.email_activity_log FOR SELECT TO authenticated USING ((SELECT public.app_role()) IN ('Admin', 'Manager'));
