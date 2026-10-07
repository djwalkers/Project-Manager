-- 048: Human Test Case review and promotion (Phase 1H).
--
--   test_case_proposals ──review──▶ Approved ──promote──▶ test_cases (canonical)
--                                                         └─ artefact_links test_cases → acceptance_criteria
--
-- * Canonical test_cases gains NULLABLE structure for later automation:
--   objective, preconditions, steps (ordered action / expected), test_type,
--   and source_ac_snapshot (the source ACs exactly as approved, each with a
--   material-content fingerprint). Existing tests stay valid with NULLs;
--   nothing is backfilled. test_ref, scenario, expected_result, actual_result,
--   status and owner remain the authoritative canonical fields.
-- * Test proposals gain the Phase 1F review layer: the AI originals stay
--   immutable; reviewed_* values, decisions, lineage (origin /
--   parent_proposal_ids, human_authored) and promotion are recorded. The
--   database enforces the same transitions as 046:
--     Proposed     → Approved | Needs Review | Rejected | Superseded
--     Needs Review → Approved | Rejected | Superseded
--     Approved     → Promoted | Needs Review | Rejected | Superseded
--     Rejected     → Needs Review (reopen)
--     Promoted, Superseded → final
-- * Approval is gated (test_approval_blockers): an unsupported procedure
--   detail or interpretation (e.g. "job logs") must be removed from the
--   wording, or explicitly accepted as Inferred with a written reason; a
--   vague expected result must be made specific; an omitted condition must
--   be restored; anything else in Needs Review — and a source AC that has
--   changed since generation — needs an explicit reviewer confirmation.
-- * Approval records the source ACs as approved (approved_ac_snapshot).
--   Promotion (promote_test_proposal) is atomic and idempotent: one canonical
--   test, test_ref by the app's nextRef rule under a per-project lock,
--   status 'Pending', linked test_cases → acceptance_criteria for every
--   source AC (the existing link direction; Requirement verification rolls up
--   through the AC, so no redundant direct Requirement link is written). It
--   refuses if a source AC changed after approval.
-- * Stale governance: a promoted test never changes when its AC does;
--   test_case_source_changes reports promoted tests whose source AC has
--   materially changed (criterion, description, type, Given/When/Then) or
--   been deleted since promotion. Its snapshot cannot be rewritten.
-- * A promoted test cannot be deleted while a proposal points at it (guard +
--   deferred FK, same idiom as 041/046); whole-project delete cascades.
-- * Reads: proposals Manager/Admin (can_write). Writes: service role, via the
--   functions below. test_generation_issues stay immutable.

-- ── Canonical test extension (additive, nullable) ──────────────────────────

ALTER TABLE public.test_cases
  ADD COLUMN objective text CHECK (length(objective) <= 2000),
  ADD COLUMN preconditions text[] CHECK (cardinality(preconditions) <= 20),
  -- [{"step": 1, "action": "…", "expected": "…" | null}] — 1..30 steps.
  ADD COLUMN steps jsonb CHECK (steps IS NULL OR (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 30)),
  ADD COLUMN test_type text CHECK (test_type IS NULL OR test_type IN ('Positive', 'Negative', 'Regression')),
  -- [{id, ref, requirement_id, criterion, description, criterion_type, given_text, when_text, then_text, status, fingerprint}]
  ADD COLUMN source_ac_snapshot jsonb CHECK (source_ac_snapshot IS NULL OR jsonb_typeof(source_ac_snapshot) = 'array');

-- ── Proposal review columns ────────────────────────────────────────────────

ALTER TABLE public.test_case_proposals
  ADD COLUMN origin text NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'split', 'merge', 'manual')),
  ADD COLUMN parent_proposal_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN human_authored boolean NOT NULL DEFAULT false,
  ADD COLUMN reviewed_title text CHECK (length(reviewed_title) BETWEEN 1 AND 300),
  ADD COLUMN reviewed_objective text CHECK (length(reviewed_objective) BETWEEN 1 AND 2000),
  ADD COLUMN reviewed_preconditions text[] CHECK (cardinality(reviewed_preconditions) <= 20),
  ADD COLUMN reviewed_steps jsonb CHECK (reviewed_steps IS NULL OR (jsonb_typeof(reviewed_steps) = 'array' AND jsonb_array_length(reviewed_steps) BETWEEN 1 AND 30)),
  ADD COLUMN reviewed_expected_result text CHECK (length(reviewed_expected_result) BETWEEN 1 AND 2000),
  ADD COLUMN reviewed_test_type text CHECK (reviewed_test_type IS NULL OR reviewed_test_type IN ('Positive', 'Negative', 'Regression')),
  ADD COLUMN review_note text CHECK (length(review_note) <= 2000),
  ADD COLUMN rejection_reason text CHECK (rejection_reason IS NULL OR rejection_reason IN ('Duplicate', 'Duplicate of an existing test', 'Incorrect interpretation', 'Unsupported behaviour', 'Too granular', 'Out of scope', 'Not testable', 'Other')),
  ADD COLUMN accepted_inferences text[] NOT NULL DEFAULT '{}',
  ADD COLUMN approved_ac_snapshot jsonb,
  ADD COLUMN review_confirmed_at timestamptz,
  ADD COLUMN review_confirmed_by_name text,
  ADD COLUMN reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by_name text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN promoted_test_id uuid,
  ADD COLUMN promoted_test_ref text,
  ADD COLUMN promoted_at timestamptz,
  ADD COLUMN promoted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN promoted_by_name text;
ALTER TABLE public.test_case_proposals
  ADD CONSTRAINT test_case_proposals_promoted_test_fkey FOREIGN KEY (promoted_test_id) REFERENCES public.test_cases (id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT test_case_proposals_test_means_promoted CHECK (promoted_test_id IS NULL OR review_status = 'Promoted'),
  ADD CONSTRAINT test_case_proposals_promoted_shape CHECK (review_status <> 'Promoted' OR (promoted_test_id IS NOT NULL AND promoted_test_ref IS NOT NULL AND promoted_at IS NOT NULL)),
  ADD CONSTRAINT test_case_proposals_approved_shape CHECK (review_status NOT IN ('Approved', 'Promoted') OR approved_ac_snapshot IS NOT NULL),
  ADD CONSTRAINT test_case_proposals_lineage CHECK (origin IN ('ai', 'manual') OR cardinality(parent_proposal_ids) >= 1);
CREATE UNIQUE INDEX test_case_proposals_promoted_test_key ON public.test_case_proposals (promoted_test_id) WHERE promoted_test_id IS NOT NULL;

-- ── Helpers ────────────────────────────────────────────────────────────────

-- Material content of an AC (whitespace/case-insensitive). Status, owner,
-- notes and evidence are not material to a test's design.
CREATE OR REPLACE FUNCTION public.test_ac_fingerprint(p_criterion text, p_description text, p_type text, p_given text, p_when text, p_then text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    lower(regexp_replace(btrim(coalesce(p_criterion, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(p_description, '')), '\s+', ' ', 'g')),
    coalesce(p_type, ''),
    lower(regexp_replace(btrim(coalesce(p_given, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(p_when, '')), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(p_then, '')), '\s+', ' ', 'g')))::text, 'UTF8')), 'hex')
$$;

-- The source ACs as they are now (array, in the given order; missing ACs are omitted).
CREATE OR REPLACE FUNCTION public.test_ac_snapshot(p_project_id uuid, p_ac_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'ref', a.ac_ref, 'requirement_id', a.requirement_id, 'criterion', a.criterion,
    'description', a.description, 'criterion_type', a.criterion_type, 'given_text', a.given_text, 'when_text', a.when_text, 'then_text', a.then_text,
    'status', a.status, 'fingerprint', public.test_ac_fingerprint(a.criterion, a.description, a.criterion_type, a.given_text, a.when_text, a.then_text)) ORDER BY x.o), '[]'::jsonb)
  FROM unnest(p_ac_ids) WITH ORDINALITY x(id, o) JOIN public.acceptance_criteria a ON a.id = x.id AND a.project_id = p_project_id
$$;

-- Normalise steps: renumbered 1..n, trimmed, every step has an action.
CREATE OR REPLACE FUNCTION public.test_norm_steps(p_steps jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'A test needs between 1 and 30 steps' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_steps) s WHERE nullif(btrim(s->>'action'), '') IS NULL) THEN
    RAISE EXCEPTION 'Every step needs an action' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('step', s.o, 'action', left(btrim(s.v->>'action'), 1000), 'expected', left(nullif(btrim(s.v->>'expected'), ''), 1000)) ORDER BY s.o)
    INTO v FROM jsonb_array_elements(p_steps) WITH ORDINALITY s(v, o);
  RETURN v;
END;
$$;

-- The wording a reviewer sees and promotion uses, lower-cased, as one text.
CREATE OR REPLACE FUNCTION public.test_proposal_text(v public.test_case_proposals)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT lower(concat_ws(' ', coalesce(v.reviewed_title, v.title), coalesce(v.reviewed_objective, v.objective),
    array_to_string(coalesce(v.reviewed_preconditions, v.preconditions), ' '),
    (SELECT string_agg(concat_ws(' ', s->>'action', s->>'expected'), ' ') FROM jsonb_array_elements(coalesce(v.reviewed_steps, v.steps)) s),
    coalesce(v.reviewed_expected_result, v.expected_result)))
$$;

-- Quoted terms of the unsupported-detail reasons still present in the wording.
CREATE OR REPLACE FUNCTION public.test_unsupported_terms(v public.test_case_proposals)
RETURNS text[] LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT t.term), '{}') FROM (
    SELECT m[1] AS term FROM unnest(v.needs_review_reasons) r, regexp_matches(r, '"([^"]+)"', 'g') m
    WHERE r ~* '^(Unsupported procedure detail|Expected result introduces an unsupported interpretation)'
  ) t WHERE strpos(public.test_proposal_text(v), lower(t.term)) > 0
$$;

-- ── Guards (replace 047's): AI originals immutable; review transitions ─────

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
      RAISE EXCEPTION 'test-generation issues are immutable';
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

-- A promoted test keeps the AC snapshot it was approved against, and its promotion history.
CREATE OR REPLACE FUNCTION public.test_cases_provenance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.test_case_proposals p WHERE p.promoted_test_id = OLD.id)
       AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
      RAISE EXCEPTION 'This Test Case was created from an approved AI proposal and cannot be deleted because its promotion history must be preserved. Change its status instead.'
        USING ERRCODE = '23503', CONSTRAINT = 'test_case_proposals_promoted_test_fkey';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.source_ac_snapshot IS DISTINCT FROM OLD.source_ac_snapshot THEN
    RAISE EXCEPTION 'a test case''s approved acceptance criteria snapshot is fixed when it is promoted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_cases_provenance_guard BEFORE UPDATE OR DELETE ON public.test_cases
  FOR EACH ROW EXECUTE FUNCTION public.test_cases_provenance_guard();

-- ── Review functions (service role only; called by /api routes) ───────────

CREATE OR REPLACE FUNCTION public.lock_test_proposal(p_proposal_id uuid, p_project_id uuid)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.test_case_proposals p WHERE p.id = p_proposal_id AND p.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test case proposal not found in this project' USING ERRCODE = 'P0002'; END IF;
  RETURN v;
END;
$$;

-- What still stands between a proposal and approval. Empty = may be approved.
-- p_confirmed: the reviewer explicitly confirmed. p_accept: the reviewer
-- accepts the remaining unsupported details as Inferred (reason recorded).
CREATE OR REPLACE FUNCTION public.test_approval_blockers(p_proposal_id uuid, p_confirmed boolean, p_accept boolean)
RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
  v_out text[] := '{}';
  v_text text;
  v_reason text;
  v_term text;
  v_needs_confirm boolean;
  v_run public.test_generation_runs%ROWTYPE;
  v_a jsonb;
  v_now jsonb;
BEGIN
  SELECT * INTO v FROM public.test_case_proposals p WHERE p.id = p_proposal_id;
  IF NOT FOUND THEN RETURN ARRAY['Proposal not found']; END IF;
  v_text := public.test_proposal_text(v);
  v_needs_confirm := v.review_status = 'Needs Review';

  FOREACH v_reason IN ARRAY v.needs_review_reasons LOOP
    IF v_reason ~* '^(Unsupported procedure detail|Expected result introduces an unsupported interpretation)' THEN
      -- Not established by any governed context: remove it, or accept it as Inferred with a reason.
      FOR v_term IN SELECT m[1] FROM regexp_matches(v_reason, '"([^"]+)"', 'g') AS m LOOP
        IF strpos(v_text, lower(v_term)) > 0 AND NOT (coalesce(p_accept, false) OR v_term = ANY (v.accepted_inferences)) THEN
          v_out := v_out || format('"%s" is not established by the acceptance criteria or their context — remove it, or accept it as Inferred with a reason.', v_term);
        END IF;
      END LOOP;
    ELSIF v_reason ~* '^Vague expected result' THEN
      FOR v_term IN SELECT m[1] FROM regexp_matches(v_reason, '"([^"]+)"', 'g') AS m LOOP
        IF strpos(v_text, lower(v_term)) > 0 THEN v_out := v_out || format('Make the expected result specific — "%s" is not checkable.', v_term); END IF;
      END LOOP;
    ELSIF v_reason ~* '^Omits ' THEN
      FOR v_term IN SELECT m[1] FROM regexp_matches(v_reason, '"([^"]+)"', 'g') AS m LOOP
        IF strpos(v_text, lower(v_term)) = 0 THEN v_out := v_out || format('Restore "%s" in the test — it is named in its behaviour.', v_term); END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- A source AC changed (or was deleted) since the tests were generated.
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = v.generation_run_id;
  v_now := public.test_ac_snapshot(v.project_id, v.source_ac_ids);
  FOR v_a IN SELECT * FROM jsonb_array_elements(v_run.input_snapshot->'acceptance_criteria') LOOP
    CONTINUE WHEN NOT ((v_a->>'id')::uuid = ANY (v.source_ac_ids));
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_now) n WHERE n->>'id' = v_a->>'id') THEN
      v_out := v_out || format('%s no longer exists — this test cannot be approved.', v_a->>'ref');
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_now) n WHERE n->>'id' = v_a->>'id'
        AND n->>'fingerprint' = public.test_ac_fingerprint(v_a->>'criterion', v_a->>'description', v_a->>'criterion_type', v_a->>'given_text', v_a->>'when_text', v_a->>'then_text')) THEN
      v_needs_confirm := true;
      IF NOT coalesce(p_confirmed, false) THEN
        v_out := v_out || format('%s has changed since these tests were generated — check the test against its current wording and confirm.', v_a->>'ref');
      END IF;
    END IF;
  END LOOP;

  IF v.review_status = 'Needs Review' AND NOT coalesce(p_confirmed, false) THEN
    v_out := v_out || 'Confirm that you reviewed this test against its acceptance criteria.'::text;
  END IF;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_test_proposal(p_proposal_id uuid, p_project_id uuid, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
  v_title text := nullif(btrim(p_fields->>'title'), '');
  v_objective text := nullif(btrim(p_fields->>'objective'), '');
  v_expected text := nullif(btrim(p_fields->>'expected_result'), '');
  v_type text := nullif(p_fields->>'test_type', '');
  v_pre text[];
  v_steps jsonb;
BEGIN
  v := public.lock_test_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be edited', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  v_pre := CASE WHEN p_fields ? 'preconditions' THEN ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(coalesce(p_fields->'preconditions', '[]'::jsonb)) x WHERE btrim(x) <> '') END;
  v_steps := CASE WHEN p_fields ? 'steps' THEN public.test_norm_steps(p_fields->'steps') END;
  -- A reviewed value equal to the AI original is stored as "not edited".
  UPDATE public.test_case_proposals p SET
    reviewed_title = CASE WHEN v_title IS NULL OR v_title = p.title THEN NULL ELSE v_title END,
    reviewed_objective = CASE WHEN v_objective IS NULL OR v_objective = p.objective THEN NULL ELSE v_objective END,
    reviewed_expected_result = CASE WHEN v_expected IS NULL OR v_expected = p.expected_result THEN NULL ELSE v_expected END,
    reviewed_test_type = CASE WHEN v_type IS NULL OR v_type = p.test_type THEN NULL ELSE v_type END,
    reviewed_preconditions = CASE WHEN v_pre IS NULL OR v_pre = p.preconditions THEN NULL ELSE v_pre END,
    reviewed_steps = CASE WHEN v_steps IS NULL OR v_steps = public.test_norm_steps(p.steps) THEN NULL ELSE v_steps END,
    review_status = CASE WHEN p.review_status = 'Approved' THEN 'Needs Review' ELSE p.review_status END,
    review_confirmed_at = CASE WHEN p.review_status = 'Approved' THEN NULL ELSE p.review_confirmed_at END,
    review_confirmed_by_name = CASE WHEN p.review_status = 'Approved' THEN NULL ELSE p.review_confirmed_by_name END,
    accepted_inferences = '{}', approved_ac_snapshot = NULL,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = v.id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_test_proposal(p_proposal_id uuid, p_project_id uuid, p_action text, p_note text, p_reason text,
  p_confirm boolean, p_accept_inferences boolean, p_user_id uuid, p_user_name text)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
  v_target text;
  v_blockers text[];
  v_accepted text[] := '{}';
BEGIN
  v := public.lock_test_proposal(p_proposal_id, p_project_id);
  v_target := CASE p_action WHEN 'approve' THEN 'Approved' WHEN 'reject' THEN 'Rejected' WHEN 'needs_review' THEN 'Needs Review' WHEN 'reopen' THEN 'Needs Review' END;
  IF v_target IS NULL THEN RAISE EXCEPTION 'Unknown review action %', p_action USING ERRCODE = '22023'; END IF;
  IF p_action = 'reopen' AND v.review_status <> 'Rejected' THEN RAISE EXCEPTION 'Only a rejected proposal can be reopened' USING ERRCODE = '55000'; END IF;
  IF v.review_status = v_target THEN RETURN v; END IF;
  IF v_target = 'Approved' THEN
    IF coalesce(p_accept_inferences, false) THEN
      IF nullif(btrim(p_note), '') IS NULL THEN
        RAISE EXCEPTION 'Record why the unsupported detail is acceptable before accepting it as Inferred' USING ERRCODE = '22023';
      END IF;
      v_accepted := public.test_unsupported_terms(v);
    END IF;
    v_blockers := public.test_approval_blockers(v.id, p_confirm, p_accept_inferences);
    IF cardinality(v_blockers) > 0 THEN
      RAISE EXCEPTION 'This test cannot be approved yet: %', array_to_string(v_blockers, ' ') USING ERRCODE = '55000';
    END IF;
  END IF;
  UPDATE public.test_case_proposals p SET review_status = v_target,
    review_note = coalesce(nullif(btrim(p_note), ''), p.review_note),
    rejection_reason = CASE WHEN v_target = 'Rejected' THEN p_reason ELSE NULL END,
    accepted_inferences = CASE WHEN v_target = 'Approved' THEN v_accepted ELSE '{}' END,
    approved_ac_snapshot = CASE WHEN v_target = 'Approved' THEN public.test_ac_snapshot(p_project_id, v.source_ac_ids) ELSE NULL END,
    review_confirmed_at = CASE WHEN v_target = 'Approved' AND coalesce(p_confirm, false) THEN now() ELSE NULL END,
    review_confirmed_by_name = CASE WHEN v_target = 'Approved' AND coalesce(p_confirm, false) THEN p_user_name ELSE NULL END,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = v.id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_test_proposal_sequence(p_run_id uuid)
RETURNS integer LANGUAGE sql SET search_path = '' AS $$
  SELECT coalesce(max(p.sequence), 0) + 1 FROM public.test_case_proposals p WHERE p.generation_run_id = p_run_id
$$;

-- Insert one human-authored (split / merge / manual) proposal. Provenance is
-- checked by test_generation_output_guard; it always starts Needs Review.
CREATE OR REPLACE FUNCTION public.insert_reviewed_test_proposal(p_run public.test_generation_runs, p_child jsonb, p_origin text, p_parents uuid[],
  p_basis text, p_confidence text, p_reasons text[], p_rationale text, p_consolidation jsonb, p_user_id uuid, p_user_name text)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
BEGIN
  IF nullif(btrim(p_child->>'title'), '') IS NULL OR nullif(btrim(p_child->>'objective'), '') IS NULL OR nullif(btrim(p_child->>'expected_result'), '') IS NULL THEN
    RAISE EXCEPTION 'Every test needs a title, an objective and an expected result' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(coalesce(p_child->'source_ac_ids', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Every test must trace to at least one acceptance criterion' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.test_case_proposals (generation_run_id, project_id, requirement_id, sequence, title, objective, preconditions, steps, expected_result,
    test_type, variation, basis, confidence, review_status, needs_review_reasons, source_ac_ids, source_fragment_ids, human_clarification_ids,
    analysis_clarification_ids, scope_note_ids, resolved_issue_ids, rationale, behaviours, consolidation, origin, parent_proposal_ids, human_authored,
    reviewed_by, reviewed_by_name, reviewed_at)
  VALUES (p_run.id, p_run.project_id, p_run.requirement_id, public.next_test_proposal_sequence(p_run.id), left(btrim(p_child->>'title'), 300),
    left(btrim(p_child->>'objective'), 2000),
    ARRAY(SELECT left(btrim(x), 1000) FROM jsonb_array_elements_text(coalesce(p_child->'preconditions', '[]'::jsonb)) x WHERE btrim(x) <> ''),
    public.test_norm_steps(p_child->'steps'), left(btrim(p_child->>'expected_result'), 2000),
    coalesce(nullif(p_child->>'test_type', ''), 'Positive'), left(nullif(btrim(p_child->>'variation'), ''), 300), p_basis, p_confidence, 'Needs Review', p_reasons,
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(p_child->'source_ac_ids') x)::uuid[],
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(coalesce(p_child->'source_fragment_ids', '[]'::jsonb)) x)::uuid[],
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(coalesce(p_child->'human_clarification_ids', '[]'::jsonb)) x)::uuid[],
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(coalesce(p_child->'analysis_clarification_ids', '[]'::jsonb)) x)::uuid[],
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(coalesce(p_child->'scope_note_ids', '[]'::jsonb)) x)::uuid[],
    ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(coalesce(p_child->'resolved_issue_ids', '[]'::jsonb)) x)::uuid[],
    left(p_rationale, 2000), coalesce(p_child->'behaviours', '[]'::jsonb), coalesce(p_consolidation, '{}'::jsonb), p_origin, coalesce(p_parents, '{}'), true,
    p_user_id, p_user_name, now())
  RETURNING * INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.split_test_proposal(p_proposal_id uuid, p_project_id uuid, p_children jsonb, p_user_id uuid, p_user_name text)
RETURNS SETOF public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.test_case_proposals%ROWTYPE;
  v_run public.test_generation_runs%ROWTYPE;
  v_child jsonb;
  v_new public.test_case_proposals%ROWTYPE;
  v_acs uuid[];
  v_f uuid[];
BEGIN
  v := public.lock_test_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be split', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_children) <> 'array' OR jsonb_array_length(p_children) < 2 THEN
    RAISE EXCEPTION 'A split needs at least two tests' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('test-proposal-seq:' || v.generation_run_id::text));
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = v.generation_run_id;
  FOR v_child IN SELECT * FROM jsonb_array_elements(p_children) LOOP
    -- A child keeps a (non-empty) subset of its parent's ACs; its other provenance is inherited.
    v_acs := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'source_ac_ids', to_jsonb(v.source_ac_ids))))::uuid[];
    v_f := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'source_fragment_ids', to_jsonb(v.source_fragment_ids))))::uuid[];
    IF cardinality(v_acs) = 0 OR NOT (v_acs <@ v.source_ac_ids AND v_f <@ v.source_fragment_ids) THEN
      RAISE EXCEPTION 'A split test may only trace to acceptance criteria and sources of the test it was split from' USING ERRCODE = '22023';
    END IF;
    v_new := public.insert_reviewed_test_proposal(v_run,
      v_child || jsonb_build_object('source_ac_ids', to_jsonb(v_acs), 'source_fragment_ids', to_jsonb(v_f),
        'test_type', coalesce(nullif(v_child->>'test_type', ''), v.reviewed_test_type, v.test_type), 'variation', coalesce(v_child->>'variation', v.variation),
        'human_clarification_ids', to_jsonb(v.human_clarification_ids), 'analysis_clarification_ids', to_jsonb(v.analysis_clarification_ids),
        'scope_note_ids', to_jsonb(v.scope_note_ids), 'resolved_issue_ids', to_jsonb(v.resolved_issue_ids), 'behaviours', v.behaviours),
      'split', ARRAY[v.id], v.basis, v.confidence,
      ARRAY(SELECT r FROM unnest(v.needs_review_reasons) r WHERE r !~* '^Combines ') || format('Split from #%s by %s — confirm before approval.', v.sequence, p_user_name),
      format('Split from proposal #%s by %s. %s', v.sequence, p_user_name, v.rationale), '{}'::jsonb, p_user_id, p_user_name);
    RETURN NEXT v_new;
  END LOOP;
  UPDATE public.test_case_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    accepted_inferences = '{}', approved_ac_snapshot = NULL,
    review_note = coalesce(p.review_note, format('Split into %s tests.', jsonb_array_length(p_children))), updated_at = now()
  WHERE p.id = v.id;
END;
$$;

-- Merge only where safe: same run (so same Requirement) and same test type.
CREATE OR REPLACE FUNCTION public.merge_test_proposals(p_proposal_ids uuid[], p_project_id uuid, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_members public.test_case_proposals[];
  v_m public.test_case_proposals%ROWTYPE;
  v_run public.test_generation_runs%ROWTYPE;
  v_new public.test_case_proposals%ROWTYPE;
  v_id uuid;
  v_union jsonb;
BEGIN
  IF cardinality(p_proposal_ids) < 2 THEN RAISE EXCEPTION 'A merge needs at least two proposals' USING ERRCODE = '22023'; END IF;
  FOREACH v_id IN ARRAY p_proposal_ids LOOP
    v_m := public.lock_test_proposal(v_id, p_project_id);
    IF v_m.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
      RAISE EXCEPTION 'Proposal #% is % and cannot be merged', v_m.sequence, lower(v_m.review_status) USING ERRCODE = '55000';
    END IF;
    v_members := v_members || v_m;
  END LOOP;
  IF (SELECT count(DISTINCT x.generation_run_id) FROM unnest(v_members) x) > 1 THEN
    RAISE EXCEPTION 'Only proposals from the same generation run can be merged' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT coalesce(x.reviewed_test_type, x.test_type)) FROM unnest(v_members) x) > 1 THEN
    RAISE EXCEPTION 'Only tests of the same type (Positive / Negative / Regression) can be merged' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('test-proposal-seq:' || v_members[1].generation_run_id::text));
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = v_members[1].generation_run_id;
  -- Lossless: the union of every member's provenance; every member's wording kept in consolidation.
  v_union := jsonb_build_object(
    'test_type', (SELECT coalesce(x.reviewed_test_type, x.test_type) FROM unnest(v_members) x LIMIT 1),
    'source_ac_ids', (SELECT jsonb_agg(DISTINCT f) FROM unnest(v_members) x, unnest(x.source_ac_ids) f),
    'source_fragment_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.source_fragment_ids) f),
    'human_clarification_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.human_clarification_ids) f),
    'analysis_clarification_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.analysis_clarification_ids) f),
    'scope_note_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.scope_note_ids) f),
    'resolved_issue_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.resolved_issue_ids) f),
    'behaviours', (SELECT coalesce(jsonb_agg(b), '[]'::jsonb) FROM unnest(v_members) x, jsonb_array_elements(x.behaviours) b));
  v_new := public.insert_reviewed_test_proposal(v_run, p_fields || v_union, 'merge', ARRAY(SELECT x.id FROM unnest(v_members) x),
    CASE WHEN EXISTS (SELECT 1 FROM unnest(v_members) x WHERE x.basis = 'Inferred') THEN 'Inferred' ELSE 'Explicit' END,
    (SELECT x.confidence FROM unnest(v_members) x ORDER BY CASE x.confidence WHEN 'Low' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END LIMIT 1),
    ARRAY(SELECT DISTINCT r FROM unnest(v_members) x, unnest(x.needs_review_reasons) r)
      || format('Merged from %s by %s — confirm before approval.', (SELECT string_agg('#' || x.sequence, ', ') FROM unnest(v_members) x), p_user_name),
    format('Merged by %s from proposals %s.', p_user_name, (SELECT string_agg('#' || x.sequence, ', ') FROM unnest(v_members) x)),
    jsonb_build_object('merged', true, 'member_count', cardinality(v_members), 'reason', 'merged by a reviewer',
      'members', (SELECT jsonb_agg(jsonb_build_object('proposal_id', x.id, 'sequence', x.sequence, 'title', coalesce(x.reviewed_title, x.title),
        'expected_result', coalesce(x.reviewed_expected_result, x.expected_result), 'steps', coalesce(x.reviewed_steps, x.steps), 'source_ac_ids', to_jsonb(x.source_ac_ids))) FROM unnest(v_members) x)),
    p_user_id, p_user_name);
  UPDATE public.test_case_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    accepted_inferences = '{}', approved_ac_snapshot = NULL,
    review_note = coalesce(p.review_note, format('Merged into proposal #%s.', v_new.sequence)), updated_at = now()
  WHERE p.id = ANY (p_proposal_ids);
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_manual_test_proposal(p_run_id uuid, p_project_id uuid, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS public.test_case_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = p_run_id AND r.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test generation run not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v_run.status NOT IN ('Completed', 'Completed with warnings') THEN
    RAISE EXCEPTION 'Manual tests can be added only to a completed generation run' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('test-proposal-seq:' || v_run.id::text));
  RETURN public.insert_reviewed_test_proposal(v_run, p_fields - 'behaviours', 'manual', '{}', 'Inferred', 'Medium',
    ARRAY['Human-authored test — confirm before approval.'],
    coalesce(nullif(btrim(p_fields->>'rationale'), ''), format('Added by %s.', p_user_name)), '{}'::jsonb, p_user_id, p_user_name);
END;
$$;

-- Promote ONE Approved proposal into ONE canonical test, atomically and idempotently.
CREATE OR REPLACE FUNCTION public.promote_test_proposal(p_proposal_id uuid, p_project_id uuid, p_ref_prefix text, p_user_id uuid, p_user_name text)
RETURNS TABLE (test_id uuid, test_ref text, already_promoted boolean, link_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v public.test_case_proposals%ROWTYPE;
  v_req public.requirements%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_blockers text[];
  v_now jsonb;
  v_steps jsonb;
  v_pre text[];
  v_scenario text;
  v_changed text;
  v_ac uuid;
BEGIN
  IF p_ref_prefix !~ '^[A-Z]{2,6}$' THEN RAISE EXCEPTION 'Invalid reference prefix' USING ERRCODE = '22023'; END IF;
  v := public.lock_test_proposal(p_proposal_id, p_project_id);
  IF v.review_status = 'Promoted' THEN
    test_id := v.promoted_test_id; test_ref := v.promoted_test_ref; already_promoted := true;
    link_count := (SELECT count(*)::integer FROM public.artefact_links l WHERE l.source_entity = 'test_cases' AND l.source_id = v.promoted_test_id);
    RETURN NEXT; RETURN;
  END IF;
  IF v.review_status <> 'Approved' THEN
    RAISE EXCEPTION 'Only an Approved test case proposal can be promoted (this one is %)', v.review_status USING ERRCODE = '55000';
  END IF;
  v_blockers := public.test_approval_blockers(v.id, true, false);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'This test cannot be promoted: %', array_to_string(v_blockers, ' ') USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_req FROM public.requirements q WHERE q.id = v.requirement_id AND q.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The Requirement no longer exists in this project' USING ERRCODE = 'P0002'; END IF;
  -- The source ACs must still exist under this Requirement, exactly as they were approved.
  v_now := public.test_ac_snapshot(p_project_id, v.source_ac_ids);
  IF jsonb_array_length(v_now) <> cardinality(v.source_ac_ids)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_now) n WHERE (n->>'requirement_id')::uuid IS DISTINCT FROM v.requirement_id) THEN
    RAISE EXCEPTION 'A source acceptance criterion no longer exists under %, so this test cannot be promoted', v_req.requirement_ref USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(n->>'ref', ', ') INTO v_changed FROM jsonb_array_elements(v_now) n
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.approved_ac_snapshot) s WHERE s->>'id' = n->>'id' AND s->>'fingerprint' = n->>'fingerprint');
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION '% changed after this test was approved — mark it Needs Review, check it against the current wording and approve again', v_changed USING ERRCODE = '55000';
  END IF;

  v_steps := public.test_norm_steps(coalesce(v.reviewed_steps, v.steps));
  v_pre := coalesce(v.reviewed_preconditions, v.preconditions);
  -- scenario keeps the existing canonical convention ("Objective: … Steps: 1) …").
  v_scenario := concat_ws(' ', coalesce(v.reviewed_title, v.title) || '.', 'Objective: ' || coalesce(v.reviewed_objective, v.objective),
    CASE WHEN cardinality(v_pre) > 0 THEN 'Preconditions: ' || array_to_string(v_pre, '; ') || '.' END,
    'Steps: ' || (SELECT string_agg(format('%s) %s%s', s->>'step', s->>'action', CASE WHEN s->>'expected' IS NOT NULL THEN ' → ' || (s->>'expected') ELSE '' END), ' ' ORDER BY (s->>'step')::integer)
                  FROM jsonb_array_elements(v_steps) s));

  -- One reference allocation at a time per project (nextRef: max PREFIX-n + 1, zero-padded to 3).
  PERFORM pg_advisory_xact_lock(hashtext('test-ref:' || p_project_id::text));
  SELECT p_ref_prefix || '-' || lpad((coalesce(max((substring(t.test_ref FROM '(?i)^' || p_ref_prefix || '-(\d+)$'))::integer), 0) + 1)::text, 3, '0')
    INTO v_ref FROM public.test_cases t WHERE t.project_id = p_project_id;
  INSERT INTO public.test_cases (project_id, test_ref, scenario, expected_result, status, objective, preconditions, steps, test_type, source_ac_snapshot)
  VALUES (p_project_id, v_ref, v_scenario, coalesce(v.reviewed_expected_result, v.expected_result), 'Pending',
    coalesce(v.reviewed_objective, v.objective), v_pre, v_steps, coalesce(v.reviewed_test_type, v.test_type), v.approved_ac_snapshot)
  RETURNING id INTO v_id;
  -- Canonical traceability, in the existing direction (test_cases → acceptance_criteria).
  FOREACH v_ac IN ARRAY v.source_ac_ids LOOP
    INSERT INTO public.artefact_links (project_id, source_entity, source_id, target_entity, target_id)
    VALUES (p_project_id, 'test_cases', v_id, 'acceptance_criteria', v_ac);
  END LOOP;
  UPDATE public.test_case_proposals p SET review_status = 'Promoted', promoted_test_id = v_id, promoted_test_ref = v_ref,
    promoted_at = now(), promoted_by = p_user_id, promoted_by_name = p_user_name, updated_at = now()
  WHERE p.id = v.id;
  test_id := v_id; test_ref := v_ref; already_promoted := false; link_count := cardinality(v.source_ac_ids);
  RETURN NEXT;
END;
$$;

-- Promoted tests whose source AC has materially changed (or gone) since promotion.
CREATE OR REPLACE FUNCTION public.test_case_source_changes(p_project_id uuid, p_test_id uuid)
RETURNS TABLE (test_id uuid, test_ref text, ac_id uuid, ac_ref text, change text, approved_criterion text, current_criterion text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT t.id, t.test_ref, (s->>'id')::uuid, coalesce(a.ac_ref, s->>'ref'),
    CASE WHEN a.id IS NULL THEN 'Deleted' ELSE 'Changed' END, s->>'criterion', a.criterion
  FROM public.test_cases t
  CROSS JOIN LATERAL jsonb_array_elements(t.source_ac_snapshot) s
  LEFT JOIN public.acceptance_criteria a ON a.id = (s->>'id')::uuid AND a.project_id = t.project_id
  WHERE t.project_id = p_project_id AND t.source_ac_snapshot IS NOT NULL AND (p_test_id IS NULL OR t.id = p_test_id)
    AND (a.id IS NULL OR public.test_ac_fingerprint(a.criterion, a.description, a.criterion_type, a.given_text, a.when_text, a.then_text) IS DISTINCT FROM s->>'fingerprint')
  ORDER BY t.test_ref, s->>'ref'
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.test_ac_snapshot(uuid, uuid[])',
    'public.test_proposal_text(public.test_case_proposals)',
    'public.test_unsupported_terms(public.test_case_proposals)',
    'public.lock_test_proposal(uuid, uuid)',
    'public.test_approval_blockers(uuid, boolean, boolean)',
    'public.edit_test_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.review_test_proposal(uuid, uuid, text, text, text, boolean, boolean, uuid, text)',
    'public.next_test_proposal_sequence(uuid)',
    'public.insert_reviewed_test_proposal(public.test_generation_runs, jsonb, text, uuid[], text, text, text[], text, jsonb, uuid, text)',
    'public.split_test_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.merge_test_proposals(uuid[], uuid, jsonb, uuid, text)',
    'public.create_manual_test_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.promote_test_proposal(uuid, uuid, text, uuid, text)',
    'public.test_case_source_changes(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.test_generation_output_guard()', 'public.test_cases_provenance_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;
