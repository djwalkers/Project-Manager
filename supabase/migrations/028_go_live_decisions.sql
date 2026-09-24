-- 028: Go/No-Go decision history.
--
-- The provider/internal Go/No-Go decision is a governance event, so it is
-- stored as an APPEND-ONLY history: a change of decision inserts a new row
-- (GO → NO_GO → GO keeps all three) and the current decision is simply the
-- latest row for the project (by decided_at, then created_at). Rows are
-- never updated or deleted — enforced below by a trigger that rejects
-- UPDATE and DELETE for every role, including service_role (apart from the
-- two foreign-key actions documented on the trigger function).
--
-- What was decided is stored here; the CURRENT deployment status (which
-- also depends on live readiness — hard stops, customer approval,
-- outstanding controls) is derived at read time in lib/go-live-decision.ts
-- and never written back, so a recorded GO is preserved even if a later
-- hard stop means deployment currently cannot proceed.
--
-- Served exclusively through the authenticated Next.js API route
-- app/api/go-live/decisions (service-role client; Admin/Manager only for
-- inserts), exactly like go_live_checklists, cutover_plan and
-- go_live_readiness_overrides (see 023 and 025): RLS is enabled with no
-- policies, so the anon/authenticated roles have no direct access at all.
-- The route also writes an audit_log 'Create' entry for each decision.

CREATE TABLE IF NOT EXISTS go_live_decisions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision             text        NOT NULL CHECK (decision IN ('GO', 'NO_GO')),
  reason               text        NOT NULL CHECK (length(btrim(reason)) > 0),
  decided_by           text        NOT NULL,
  decided_by_user_id   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_go_live_decisions_project
  ON go_live_decisions (project_id, decided_at DESC, created_at DESC);

ALTER TABLE go_live_decisions ENABLE ROW LEVEL SECURITY;

-- Append-only guard. Two foreign-key actions are the ONLY permitted
-- changes, so user/project deletion keeps working:
--   * UPDATE — the author's account was deleted and decided_by_user_id's
--     ON DELETE SET NULL clears it. Every other column, including the
--     immutable textual decided_by snapshot, must be unchanged, and the
--     referenced account must no longer exist (a manual "null the author"
--     while the user still exists is rejected).
--   * DELETE — the project itself was deleted (project_id ON DELETE
--     CASCADE): allowed only once the parent project no longer exists.
-- Everything else raises. SECURITY DEFINER + empty search_path so the
-- existence checks work whichever role performs the parent deletion.
CREATE OR REPLACE FUNCTION public.go_live_decisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.decided_by_user_id IS NOT NULL
       AND NEW.decided_by_user_id IS NULL
       AND NEW.id = OLD.id
       AND NEW.project_id = OLD.project_id
       AND NEW.decision = OLD.decision
       AND NEW.reason = OLD.reason
       AND NEW.decided_by = OLD.decided_by
       AND NEW.decided_at = OLD.decided_at
       AND NEW.created_at = OLD.created_at
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.decided_by_user_id) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'go_live_decisions is append-only: record a new decision instead of changing or deleting one';
END;
$$;

DROP TRIGGER IF EXISTS go_live_decisions_no_update_delete ON go_live_decisions;
CREATE TRIGGER go_live_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON go_live_decisions
  FOR EACH ROW EXECUTE FUNCTION go_live_decisions_append_only();
