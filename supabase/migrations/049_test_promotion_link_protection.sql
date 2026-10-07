-- 049: Phase 1H integrity — protected promotion links; test-design issue review.
--
-- * A promoted test's originating test ↔ Acceptance Criterion link (one per
--   source AC of the proposal that created the test, migration 048) is part
--   of the test's provenance and drives AC verification, Test Status and
--   stale-test comparison. It cannot be deleted or re-pointed through any
--   path (generic link editor, API routes, service role, direct SQL): the
--   artefact_links guard below refuses it. Still allowed:
--     - removing a duplicate row while another link for the same test/AC
--       pair remains (the relationship itself survives);
--     - cascades: whole-project delete, and migration 033's link cleanup
--       when the AC itself is deleted (a manual AC stays deletable; the
--       test is then reported 'Deleted' by test_case_source_changes).
--   Manually-created and other non-origin links behave exactly as before.
--   Nothing here changes source_ac_snapshot, proposals or tests.
-- * Test-generation issues gain the Phase 1F review state (046 pattern):
--   Open / Resolved / Accepted / Not Applicable, a resolution note and the
--   reviewer/time. Only those fields may change; the AI output stays
--   immutable. Issues never affect canonical tests.

-- ── Protected promotion links ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.test_promotion_link_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_test uuid;
  v_ac uuid;
  v_test_ref text;
  v_ac_ref text;
BEGIN
  IF OLD.source_entity = 'test_cases' AND OLD.target_entity = 'acceptance_criteria' THEN
    v_test := OLD.source_id; v_ac := OLD.target_id;
  ELSIF OLD.source_entity = 'acceptance_criteria' AND OLD.target_entity = 'test_cases' THEN
    v_test := OLD.target_id; v_ac := OLD.source_id;
  ELSE
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- An update that keeps the same relationship (and project) is harmless.
  IF TG_OP = 'UPDATE' AND NEW.source_entity = OLD.source_entity AND NEW.source_id = OLD.source_id
     AND NEW.target_entity = OLD.target_entity AND NEW.target_id = OLD.target_id AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  SELECT t.test_ref INTO v_test_ref FROM public.test_cases t
    WHERE t.id = v_test AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = t.project_id);
  SELECT a.ac_ref INTO v_ac_ref FROM public.acceptance_criteria a WHERE a.id = v_ac;
  IF v_test_ref IS NOT NULL AND v_ac_ref IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.test_case_proposals p WHERE p.promoted_test_id = v_test AND v_ac = ANY (p.source_ac_ids))
     AND NOT EXISTS (SELECT 1 FROM public.artefact_links l WHERE l.id <> OLD.id
       AND ((l.source_entity = 'test_cases' AND l.source_id = v_test AND l.target_entity = 'acceptance_criteria' AND l.target_id = v_ac)
         OR (l.source_entity = 'acceptance_criteria' AND l.source_id = v_ac AND l.target_entity = 'test_cases' AND l.target_id = v_test))) THEN
    RAISE EXCEPTION 'The link between % and % was created through approved test promotion and forms part of the test''s provenance, so it cannot be removed.', v_test_ref, v_ac_ref
      USING ERRCODE = '23503', CONSTRAINT = 'test_case_promotion_link';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER artefact_links_test_promotion_guard BEFORE UPDATE OR DELETE ON public.artefact_links
  FOR EACH ROW EXECUTE FUNCTION public.test_promotion_link_guard();

-- ── Test-design issue review (046 pattern) ─────────────────────────────────

ALTER TABLE public.test_generation_issues
  ADD COLUMN resolution_note text CHECK (length(resolution_note) <= 2000),
  ADD COLUMN reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by_name text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Replaces 048's guard: issues may change only their review fields.
CREATE OR REPLACE FUNCTION public.test_generation_output_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
  v_cols text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.test_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'generated test cases are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME <> 'test_case_proposals' THEN
      v_cols := ARRAY['status', 'resolution_note', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'updated_at'];
      IF (to_jsonb(NEW) - v_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_cols) THEN
        RAISE EXCEPTION 'test-generation issues are immutable; only their review fields may change';
      END IF;
      RETURN NEW;
    END IF;
    v_cols := ARRAY['review_status', 'updated_at', 'reviewed_title', 'reviewed_objective', 'reviewed_preconditions', 'reviewed_steps', 'reviewed_expected_result',
      'reviewed_test_type', 'review_note', 'rejection_reason', 'accepted_inferences', 'approved_ac_snapshot', 'review_confirmed_at', 'review_confirmed_by_name',
      'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'promoted_test_id', 'promoted_test_ref', 'promoted_at', 'promoted_by', 'promoted_by_name'];
    IF (to_jsonb(NEW) - v_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_cols) THEN
      RAISE EXCEPTION 'generated test cases are immutable; only their review fields may change';
    END IF;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NOT (
         (OLD.review_status = 'Proposed' AND NEW.review_status IN ('Approved', 'Needs Review', 'Rejected', 'Superseded'))
      OR (OLD.review_status = 'Needs Review' AND NEW.review_status IN ('Approved', 'Rejected', 'Superseded'))
      OR (OLD.review_status = 'Approved' AND NEW.review_status IN ('Promoted', 'Needs Review', 'Rejected', 'Superseded'))
      OR (OLD.review_status = 'Rejected' AND NEW.review_status = 'Needs Review')) THEN
      RAISE EXCEPTION 'a test case proposal cannot move from % to %', OLD.review_status, NEW.review_status;
    END IF;
    IF OLD.promoted_test_id IS NOT NULL AND NEW.promoted_test_id IS DISTINCT FROM OLD.promoted_test_id THEN
      RAISE EXCEPTION 'a promoted proposal keeps the canonical test case it created';
    END IF;
    IF OLD.review_status IN ('Promoted', 'Superseded')
       AND (to_jsonb(NEW) - 'updated_at' - 'reviewed_by' - 'promoted_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'reviewed_by' - 'promoted_by') THEN
      RAISE EXCEPTION 'a % test case proposal is final', lower(OLD.review_status);
    END IF;
    IF NEW.review_status = 'Promoted' AND OLD.review_status <> 'Promoted' AND NEW.promoted_test_id IS NULL THEN
      RAISE EXCEPTION 'a proposal becomes Promoted only with the canonical test case it created';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = NEW.generation_run_id;
  IF NEW.requirement_id IS DISTINCT FROM v_run.requirement_id THEN
    RAISE EXCEPTION 'output must belong to the run''s Requirement' USING ERRCODE = '22023';
  END IF;
  IF NOT NEW.source_fragment_ids <@ v_run.allowed_fragment_ids THEN
    RAISE EXCEPTION 'every cited source fragment must be one supplied to the generation run' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'test_case_proposals' THEN
    IF NOT NEW.source_ac_ids <@ v_run.ac_ids THEN
      RAISE EXCEPTION 'every source acceptance criterion must be one of the run''s acceptance criteria' USING ERRCODE = '22023';
    END IF;
    IF NOT (NEW.human_clarification_ids <@ v_run.human_clarification_ids AND NEW.analysis_clarification_ids <@ v_run.analysis_clarification_ids
            AND NEW.scope_note_ids <@ v_run.scope_note_ids AND NEW.resolved_issue_ids <@ v_run.resolved_issue_ids) THEN
      RAISE EXCEPTION 'every cited clarification, scope note and resolved question must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT NEW.ac_ids <@ v_run.ac_ids THEN
      RAISE EXCEPTION 'every acceptance criterion an issue cites must be one of the run''s acceptance criteria' USING ERRCODE = '22023';
    END IF;
    IF NOT NEW.source_issue_ids <@ (v_run.open_issue_ids || v_run.resolved_issue_ids) THEN
      RAISE EXCEPTION 'every question an issue cites must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_test_generation_issue(p_issue_id uuid, p_project_id uuid, p_status text, p_note text, p_user_id uuid, p_user_name text)
RETURNS public.test_generation_issues
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_generation_issues%ROWTYPE;
BEGIN
  IF p_status NOT IN ('Open', 'Resolved', 'Accepted', 'Not Applicable') THEN RAISE EXCEPTION 'Unknown issue status %', p_status USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM public.test_generation_issues i WHERE i.id = p_issue_id AND i.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test-design issue not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF p_status IN ('Resolved', 'Not Applicable') AND nullif(btrim(coalesce(p_note, v.resolution_note)), '') IS NULL THEN
    RAISE EXCEPTION 'Record how the issue was resolved (or why it does not apply)' USING ERRCODE = '22023';
  END IF;
  UPDATE public.test_generation_issues i SET status = p_status, resolution_note = coalesce(nullif(btrim(p_note), ''), i.resolution_note),
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE i.id = v.id RETURNING i.* INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.review_test_generation_issue(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_test_generation_issue(uuid, uuid, text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.test_promotion_link_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.test_generation_output_guard() FROM PUBLIC, anon, authenticated;
