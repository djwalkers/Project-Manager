-- 030: close role escalation; reusable role helpers; pinned search paths.
--
-- Two escalation paths existed (Phase 0B discovery):
--   1. handle_new_user copied raw_user_meta_data->>'role' into
--      user_profiles.role. raw_user_meta_data is whatever the client sends
--      in auth.signUp({ options: { data } }), so a signup could request Admin.
--   2. profiles_update_own let any signed-in user UPDATE their own row with
--      no column restriction, including role (Viewer -> Admin).
--
-- After this migration:
--   - a new user's profile is ALWAYS created as Viewer (metadata role ignored);
--   - through the Data API (anon / authenticated roles) only full_name and
--     role are updatable, and role only by an Admin, and never on their own
--     row; id / created_at are immutable;
--   - the server (service_role), the dashboard and migrations still
--     administer roles directly — the guard only constrains API end users.
-- Existing users and roles are NOT changed.
--
-- Also adds role helpers for the Phase 0B2 policies (not used by any policy
-- yet) and pins search_path on every SECURITY DEFINER / trigger function.
-- No table policies are changed here; anon read policies remain (Phase 0B2).

-- ── Role helpers ────────────────────────────────────────────────────────────
-- A signed-in user with no profile row (or an unrecognised role) resolves to
-- NULL / false everywhere, so they gain no access through these helpers.

CREATE OR REPLACE FUNCTION public.app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.role
  FROM public.user_profiles p
  WHERE p.id = auth.uid()
    AND p.role IN ('Admin', 'Manager', 'Viewer');
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(public.app_role() = 'Admin', false);
$$;

CREATE OR REPLACE FUNCTION public.can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(public.app_role() IN ('Admin', 'Manager'), false);
$$;

CREATE OR REPLACE FUNCTION public.can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.app_role() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.app_role(), public.is_admin(), public.can_write(), public.can_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_role(), public.is_admin(), public.can_write(), public.can_read() TO anon, authenticated, service_role;

-- Existing helper used by every current policy: same result, pinned path.
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role FROM public.user_profiles WHERE id = auth.uid();
$$;

ALTER FUNCTION public.set_updated_at() SET search_path = '';

-- ── New users are always Viewer ─────────────────────────────────────────────
-- full_name may still come from signup metadata (display only); role never.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''), NEW.email, ''),
    'Viewer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── Profile update guard ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.user_profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Only Data API end users are constrained. service_role (server routes),
  -- postgres (dashboard / migrations) administer profiles directly.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_profiles.id and created_at cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF OLD.id = auth.uid() THEN
      RAISE EXCEPTION 'You cannot change your own role'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Only an Admin can change a user''s role'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profiles_guard ON public.user_profiles;
CREATE TRIGGER user_profiles_guard
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_guard();

-- Column-level privileges: the API may only ever touch full_name and role
-- (role further restricted by the guard above). No direct INSERT/DELETE —
-- profiles are created by handle_new_user and removed by the auth.users FK.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_profiles FROM anon, authenticated;
GRANT UPDATE (full_name, role) ON public.user_profiles TO authenticated;
