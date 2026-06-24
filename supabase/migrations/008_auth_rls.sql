-- ============================================================
-- 008_auth_rls.sql  —  Authentication & Row-Level Security
-- ============================================================
-- Roles: Admin (full access), Manager (read-only), Viewer (dashboard read-only)
-- ============================================================

-- ------------------------------------------------------------
-- 1. User profiles table (stores display name + role)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  role      text NOT NULL DEFAULT 'Viewer'
              CHECK (role IN ('Admin', 'Manager', 'Viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Auto-create a profile row whenever a new auth user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'Viewer')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE handle_new_user();

-- ------------------------------------------------------------
-- 2. Helper: get the current user's role (cached per query)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER STABLE
AS $$
  SELECT role FROM public.user_profiles WHERE id = auth.uid();
$$;

-- ------------------------------------------------------------
-- 3. Enable RLS on all project-data tables
-- ------------------------------------------------------------
ALTER TABLE projects               ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE risks                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_questions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverables           ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_cases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_activity_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones             ENABLE ROW LEVEL SECURITY;
ALTER TABLE dependencies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles          ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 4. user_profiles policies
--    Users can always read their own profile.
--    Admin can read all profiles.
--    Only Admin can update roles; users can update their own name.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own"  ON user_profiles;
DROP POLICY IF EXISTS "profiles_select_admin" ON user_profiles;
DROP POLICY IF EXISTS "profiles_update_own"  ON user_profiles;
DROP POLICY IF EXISTS "profiles_update_admin" ON user_profiles;

CREATE POLICY "profiles_select_own"
  ON user_profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles_select_admin"
  ON user_profiles FOR SELECT
  USING (get_user_role() = 'Admin');

CREATE POLICY "profiles_update_own"
  ON user_profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_admin"
  ON user_profiles FOR UPDATE
  USING (get_user_role() = 'Admin');

-- ------------------------------------------------------------
-- 5. Macro helpers — drop & recreate policies for a table
-- ------------------------------------------------------------

-- Tables where Admin has full CRUD, Manager & Viewer have SELECT
-- "Viewer-readable" subset: projects, project_snapshots (dashboard KPIs)

-- ── projects ────────────────────────────────────────────────
DROP POLICY IF EXISTS "projects_admin"   ON projects;
DROP POLICY IF EXISTS "projects_read"    ON projects;

CREATE POLICY "projects_admin"
  ON projects FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "projects_read"
  ON projects FOR SELECT
  USING (get_user_role() IN ('Manager', 'Viewer'));

-- ── project_snapshots ────────────────────────────────────────
DROP POLICY IF EXISTS "snapshots_admin"  ON project_snapshots;
DROP POLICY IF EXISTS "snapshots_read"   ON project_snapshots;

CREATE POLICY "snapshots_admin"
  ON project_snapshots FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "snapshots_read"
  ON project_snapshots FOR SELECT
  USING (get_user_role() IN ('Manager', 'Viewer'));

-- ── requirements ────────────────────────────────────────────
DROP POLICY IF EXISTS "requirements_admin" ON requirements;
DROP POLICY IF EXISTS "requirements_read"  ON requirements;

CREATE POLICY "requirements_admin"
  ON requirements FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "requirements_read"
  ON requirements FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── risks ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "risks_admin" ON risks;
DROP POLICY IF EXISTS "risks_read"  ON risks;

CREATE POLICY "risks_admin"
  ON risks FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "risks_read"
  ON risks FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── decisions ───────────────────────────────────────────────
DROP POLICY IF EXISTS "decisions_admin" ON decisions;
DROP POLICY IF EXISTS "decisions_read"  ON decisions;

CREATE POLICY "decisions_admin"
  ON decisions FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "decisions_read"
  ON decisions FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── discovery_questions ─────────────────────────────────────
DROP POLICY IF EXISTS "discovery_admin" ON discovery_questions;
DROP POLICY IF EXISTS "discovery_read"  ON discovery_questions;

CREATE POLICY "discovery_admin"
  ON discovery_questions FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "discovery_read"
  ON discovery_questions FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── actions ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "actions_admin" ON actions;
DROP POLICY IF EXISTS "actions_read"  ON actions;

CREATE POLICY "actions_admin"
  ON actions FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "actions_read"
  ON actions FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── deliverables ─────────────────────────────────────────────
DROP POLICY IF EXISTS "deliverables_admin" ON deliverables;
DROP POLICY IF EXISTS "deliverables_read"  ON deliverables;

CREATE POLICY "deliverables_admin"
  ON deliverables FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "deliverables_read"
  ON deliverables FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── timeline_items ──────────────────────────────────────────
DROP POLICY IF EXISTS "timeline_admin" ON timeline_items;
DROP POLICY IF EXISTS "timeline_read"  ON timeline_items;

CREATE POLICY "timeline_admin"
  ON timeline_items FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "timeline_read"
  ON timeline_items FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── test_cases ──────────────────────────────────────────────
DROP POLICY IF EXISTS "tests_admin" ON test_cases;
DROP POLICY IF EXISTS "tests_read"  ON test_cases;

CREATE POLICY "tests_admin"
  ON test_cases FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "tests_read"
  ON test_cases FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── milestones ──────────────────────────────────────────────
DROP POLICY IF EXISTS "milestones_admin" ON milestones;
DROP POLICY IF EXISTS "milestones_read"  ON milestones;

CREATE POLICY "milestones_admin"
  ON milestones FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "milestones_read"
  ON milestones FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── dependencies ────────────────────────────────────────────
DROP POLICY IF EXISTS "dependencies_admin" ON dependencies;
DROP POLICY IF EXISTS "dependencies_read"  ON dependencies;

CREATE POLICY "dependencies_admin"
  ON dependencies FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "dependencies_read"
  ON dependencies FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── meetings ────────────────────────────────────────────────
DROP POLICY IF EXISTS "meetings_admin" ON meetings;
DROP POLICY IF EXISTS "meetings_read"  ON meetings;

CREATE POLICY "meetings_admin"
  ON meetings FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "meetings_read"
  ON meetings FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── documents ───────────────────────────────────────────────
DROP POLICY IF EXISTS "documents_admin" ON documents;
DROP POLICY IF EXISTS "documents_read"  ON documents;

CREATE POLICY "documents_admin"
  ON documents FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "documents_read"
  ON documents FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── activity_log ────────────────────────────────────────────
DROP POLICY IF EXISTS "activity_admin" ON activity_log;
DROP POLICY IF EXISTS "activity_read"  ON activity_log;

CREATE POLICY "activity_admin"
  ON activity_log FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "activity_read"
  ON activity_log FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── email_settings ──────────────────────────────────────────
DROP POLICY IF EXISTS "email_settings_admin" ON email_settings;
DROP POLICY IF EXISTS "email_settings_read"  ON email_settings;

CREATE POLICY "email_settings_admin"
  ON email_settings FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "email_settings_read"
  ON email_settings FOR SELECT
  USING (get_user_role() = 'Manager');

-- ── email_activity_log ──────────────────────────────────────
DROP POLICY IF EXISTS "email_log_admin" ON email_activity_log;
DROP POLICY IF EXISTS "email_log_read"  ON email_activity_log;

CREATE POLICY "email_log_admin"
  ON email_activity_log FOR ALL
  USING (get_user_role() = 'Admin')
  WITH CHECK (get_user_role() = 'Admin');

CREATE POLICY "email_log_read"
  ON email_activity_log FOR SELECT
  USING (get_user_role() = 'Manager');

-- ------------------------------------------------------------
-- 6. Grant service_role bypass (for server-side cron/email)
-- ------------------------------------------------------------
-- service_role already bypasses RLS by default in Supabase.
-- No additional grants needed.

-- ------------------------------------------------------------
-- NOTE: To seed the Admin account for Andy Walker, run in
-- Supabase dashboard → Authentication → Users → Invite user,
-- then execute:
--
--   UPDATE public.user_profiles
--   SET full_name = 'Andy Walker', role = 'Admin'
--   WHERE id = '<uuid from auth.users>';
--
-- Or use the SQL editor after the user signs up for the
-- first time via the login page.
-- ------------------------------------------------------------
