-- 015: Allow server-side (unauthenticated anon) reads of all project data tables
-- so that scheduled email routes can load project data without a user session.
--
-- Context: migration 008 enabled RLS on all tables with policies keyed to
-- get_user_role() = 'Admin'/'Manager'. Vercel cron routes use the anon Supabase
-- client (no auth session), so auth.uid() is null, get_user_role() returns null,
-- and no policy matches — loadProjectData() returns empty arrays for every project
-- table, causing selectCanonicalProjects() → [] and projectIds=[].
--
-- When SUPABASE_SERVICE_ROLE_KEY is configured in Vercel, it bypasses RLS
-- entirely and these policies are never evaluated. These policies serve as a
-- fallback when only NEXT_PUBLIC_SUPABASE_ANON_KEY is available.

-- ── projects ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "projects_anon_read" ON projects;
CREATE POLICY "projects_anon_read" ON projects FOR SELECT TO anon USING (true);

-- ── requirements ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "requirements_anon_read" ON requirements;
CREATE POLICY "requirements_anon_read" ON requirements FOR SELECT TO anon USING (true);

-- ── deliverables ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "deliverables_anon_read" ON deliverables;
CREATE POLICY "deliverables_anon_read" ON deliverables FOR SELECT TO anon USING (true);

-- ── risks ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "risks_anon_read" ON risks;
CREATE POLICY "risks_anon_read" ON risks FOR SELECT TO anon USING (true);

-- ── decisions ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "decisions_anon_read" ON decisions;
CREATE POLICY "decisions_anon_read" ON decisions FOR SELECT TO anon USING (true);

-- ── actions ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "actions_anon_read" ON actions;
CREATE POLICY "actions_anon_read" ON actions FOR SELECT TO anon USING (true);

-- ── dependencies ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "dependencies_anon_read" ON dependencies;
CREATE POLICY "dependencies_anon_read" ON dependencies FOR SELECT TO anon USING (true);

-- ── discovery_questions ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "discovery_questions_anon_read" ON discovery_questions;
CREATE POLICY "discovery_questions_anon_read" ON discovery_questions FOR SELECT TO anon USING (true);

-- ── milestones ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "milestones_anon_read" ON milestones;
CREATE POLICY "milestones_anon_read" ON milestones FOR SELECT TO anon USING (true);

-- ── timeline_items ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "timeline_items_anon_read" ON timeline_items;
CREATE POLICY "timeline_items_anon_read" ON timeline_items FOR SELECT TO anon USING (true);

-- ── project_snapshots ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "project_snapshots_anon_read" ON project_snapshots;
CREATE POLICY "project_snapshots_anon_read" ON project_snapshots FOR SELECT TO anon USING (true);

-- ── test_cases ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "test_cases_anon_read" ON test_cases;
CREATE POLICY "test_cases_anon_read" ON test_cases FOR SELECT TO anon USING (true);

-- ── meetings ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "meetings_anon_read" ON meetings;
CREATE POLICY "meetings_anon_read" ON meetings FOR SELECT TO anon USING (true);

-- ── documents ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "documents_anon_read" ON documents;
CREATE POLICY "documents_anon_read" ON documents FOR SELECT TO anon USING (true);

-- ── activity_log ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "activity_log_anon_read" ON activity_log;
CREATE POLICY "activity_log_anon_read" ON activity_log FOR SELECT TO anon USING (true);

-- ── go_live_checklists ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "go_live_checklists_anon_read" ON go_live_checklists;
CREATE POLICY "go_live_checklists_anon_read" ON go_live_checklists FOR SELECT TO anon USING (true);

-- ── cutover_plan ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "cutover_plan_anon_read" ON cutover_plan;
CREATE POLICY "cutover_plan_anon_read" ON cutover_plan FOR SELECT TO anon USING (true);

-- ── audit_log ─────────────────────────────────────────────────────────────────
-- Required by getChangesSince() which uses the anon client to query audit history
-- for the Daily Brief recent-activity section.
DROP POLICY IF EXISTS "audit_log_anon_read" ON audit_log;
CREATE POLICY "audit_log_anon_read" ON audit_log FOR SELECT TO anon USING (true);
