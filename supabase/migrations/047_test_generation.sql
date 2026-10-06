-- 047: AI Test Case generation (Phase 1G) — GENERATION ONLY.
--
--   requirements ──1:n── test_generation_runs ──1:n── test_generation_stage_results
--   (+ its canonical ACs)                      ├─1:n── test_case_proposals
--                                              └─1:n── test_generation_issues
--
-- * A run covers ONE Requirement and a chosen set of ITS canonical
--   Acceptance Criteria (any AC: manually created or promoted from an AI
--   proposal; criterion_type / Given-When-Then not required). The Requirement
--   may be signed off — tests are still designed for it.
-- * The input is fixed when the run is queued (test_generation_input): the
--   Requirement, each AC's canonical text, and — for ACs promoted from an AI
--   proposal — that proposal's source fragments, the Human Clarifications
--   and analysis clarifications it relied on, the scope notes it cites, the
--   generation questions resolved for it, and the questions still open
--   (never facts). Scope notes explicitly associated with the Requirement
--   (046) are included; other change-level notes are not. When the
--   Requirement itself was promoted from analysis, its source fragments are
--   supplied as context. Existing canonical Test Cases and their links are
--   NEVER part of the input.
-- * Same worker token, lease/retry, stage reuse and immutability contract as
--   Phase 1E (043). Lowest worker priority: extraction → requirement
--   analysis → AC generation → test generation.
-- * Output is NON-AUTHORITATIVE: test_case_proposals carry no test_ref and
--   nothing here writes test_cases, artefact_links, acceptance_criteria or
--   requirements. The database — never the model — sets review_status.
-- * Every proposal traces to at least one of the run's ACs; every cited id
--   must be one the run was given.
-- * Reads: Manager/Admin only (can_write). Writes: service role only.

-- ── Generation runs ────────────────────────────────────────────────────────

CREATE TABLE public.test_generation_runs (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                 uuid        NOT NULL,
  requirement_id             uuid        NOT NULL,
  ac_ids                     uuid[]      NOT NULL CHECK (cardinality(ac_ids) BETWEEN 1 AND 50),
  status                     text        NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Running', 'Completed', 'Completed with warnings', 'Failed')),
  trigger                    text        NOT NULL CHECK (trigger IN ('manual', 'retry')),
  retry_of_run_id            uuid        REFERENCES public.test_generation_runs(id) ON DELETE SET NULL,
  requested_by               uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name          text,
  queued_at                  timestamptz NOT NULL DEFAULT now(),
  started_at                 timestamptz,
  completed_at               timestamptz,
  lease_expires_at           timestamptz,
  attempt_count              integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts               integer     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  worker_id                  uuid        REFERENCES public.worker_credentials(id) ON DELETE SET NULL,
  worker_name                text,
  worker_version             text,
  model                      text        NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'),
  model_digest               text,
  prompt_version             text,
  prompt_sha256              text        CHECK (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version             text,
  input_snapshot             jsonb       NOT NULL,
  input_sha256               text        NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  allowed_fragment_ids       uuid[]      NOT NULL DEFAULT '{}',
  extraction_job_ids         uuid[]      NOT NULL DEFAULT '{}',
  human_clarification_ids    uuid[]      NOT NULL DEFAULT '{}',
  analysis_clarification_ids uuid[]      NOT NULL DEFAULT '{}',
  scope_note_ids             uuid[]      NOT NULL DEFAULT '{}',
  resolved_issue_ids         uuid[]      NOT NULL DEFAULT '{}',
  open_issue_ids             uuid[]      NOT NULL DEFAULT '{}',
  proposal_count             integer,
  issue_count                integer,
  needs_review_count         integer,
  warnings_count             integer,
  diagnostics                jsonb,
  error_category             text        CHECK (error_category IN ('ollama_unreachable', 'model_unavailable', 'invalid_model_output', 'validation_failed', 'context_too_large', 'model_timeout', 'worker_timeout', 'upload_failed', 'internal_error')),
  error_message              text        CHECK (length(error_message) <= 1000),
  CONSTRAINT test_generation_runs_requirement_fkey FOREIGN KEY (requirement_id, project_id) REFERENCES public.requirements (id, project_id) ON DELETE CASCADE,
  CONSTRAINT test_generation_runs_id_project_key UNIQUE (id, project_id),
  CONSTRAINT test_generation_runs_completed_shape CHECK (status NOT IN ('Completed', 'Completed with warnings')
    OR (completed_at IS NOT NULL AND prompt_version IS NOT NULL AND schema_version IS NOT NULL AND proposal_count IS NOT NULL AND issue_count IS NOT NULL)),
  CONSTRAINT test_generation_runs_failed_shape CHECK (status <> 'Failed' OR (error_category IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX test_generation_runs_one_active_per_requirement ON public.test_generation_runs (requirement_id) WHERE status IN ('Queued', 'Running');
CREATE INDEX test_generation_runs_queue_idx ON public.test_generation_runs (status, queued_at);
CREATE INDEX test_generation_runs_requirement_idx ON public.test_generation_runs (requirement_id, queued_at DESC);

-- ── Stage results (resumable, insert-only; same contract as 043) ─────────

CREATE TABLE public.test_generation_stage_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id  uuid        NOT NULL REFERENCES public.test_generation_runs(id) ON DELETE CASCADE,
  stage              text        NOT NULL CHECK (stage IN ('behaviours', 'tests', 'coverage')),
  chunk_key          text        NOT NULL CHECK (chunk_key ~ '^[A-Za-z0-9:._-]{1,80}$'),
  input_hash         text        NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  model              text        NOT NULL,
  prompt_version     text        NOT NULL,
  attempts           integer     NOT NULL CHECK (attempts >= 1),
  reused_from_run_id uuid        REFERENCES public.test_generation_runs(id) ON DELETE SET NULL,
  output             jsonb       NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_generation_stage_results_key UNIQUE (generation_run_id, stage, chunk_key)
);

-- ── Proposed test cases and generation issues (non-authoritative) ─────────

CREATE TABLE public.test_case_proposals (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id          uuid        NOT NULL,
  project_id                 uuid        NOT NULL,
  requirement_id             uuid        NOT NULL,
  sequence                   integer     NOT NULL CHECK (sequence >= 1),
  title                      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  objective                  text        NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
  preconditions              text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(preconditions) <= 20),
  -- [{"step": 1, "action": "…", "expected": "…" | null}] — 1..30 steps.
  steps                      jsonb       NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 30),
  expected_result            text        NOT NULL CHECK (length(expected_result) BETWEEN 1 AND 2000),
  test_type                  text        NOT NULL CHECK (test_type IN ('Positive', 'Negative', 'Regression')),
  variation                  text        CHECK (length(variation) <= 300),
  basis                      text        NOT NULL CHECK (basis IN ('Explicit', 'Inferred')),
  confidence                 text        NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
  review_status              text        NOT NULL CHECK (review_status IN ('Proposed', 'Needs Review', 'Approved', 'Rejected', 'Promoted', 'Superseded')),
  needs_review_reasons       text[]      NOT NULL DEFAULT '{}',
  source_ac_ids              uuid[]      NOT NULL CHECK (cardinality(source_ac_ids) >= 1),
  source_fragment_ids        uuid[]      NOT NULL DEFAULT '{}',
  human_clarification_ids    uuid[]      NOT NULL DEFAULT '{}',
  analysis_clarification_ids uuid[]      NOT NULL DEFAULT '{}',
  scope_note_ids             uuid[]      NOT NULL DEFAULT '{}',
  resolved_issue_ids         uuid[]      NOT NULL DEFAULT '{}',
  rationale                  text        NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  behaviours                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  consolidation              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_case_proposals_run_fkey FOREIGN KEY (generation_run_id, project_id) REFERENCES public.test_generation_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT test_case_proposals_run_sequence_key UNIQUE (generation_run_id, sequence),
  CONSTRAINT test_case_proposals_needs_review CHECK (
    review_status <> 'Proposed' OR (basis = 'Explicit' AND confidence <> 'Low' AND cardinality(needs_review_reasons) = 0))
);
CREATE INDEX test_case_proposals_run_idx ON public.test_case_proposals (generation_run_id, sequence);
CREATE INDEX test_case_proposals_requirement_idx ON public.test_case_proposals (requirement_id);

CREATE TABLE public.test_generation_issues (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id   uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  requirement_id      uuid        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),
  issue_type          text        NOT NULL CHECK (issue_type IN ('Uncovered Acceptance Criterion', 'Uncovered Behaviour', 'Missing Test Detail', 'Additional Coverage Question',
                                    'Unresolved Question', 'Insufficient Source Support', 'Ambiguous Expected Result', 'Conflicting Context')),
  severity            text        NOT NULL CHECK (severity IN ('High', 'Medium', 'Low')),
  description         text        NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  behaviour           text        CHECK (length(behaviour) <= 1000),
  suggested_question  text        CHECK (length(suggested_question) <= 1000),
  ac_ids              uuid[]      NOT NULL DEFAULT '{}',
  source_fragment_ids uuid[]      NOT NULL DEFAULT '{}',
  source_issue_ids    uuid[]      NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Accepted', 'Not Applicable')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_generation_issues_run_fkey FOREIGN KEY (generation_run_id, project_id) REFERENCES public.test_generation_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT test_generation_issues_run_sequence_key UNIQUE (generation_run_id, sequence)
);
CREATE INDEX test_generation_issues_run_idx ON public.test_generation_issues (generation_run_id, sequence);

-- ── Guards ─────────────────────────────────────────────────────────────────

-- Every cited id must be one the run was given; requirement matches the run.
CREATE OR REPLACE FUNCTION public.test_generation_output_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'generated test cases and test-generation issues are immutable in Phase 1G (review comes later)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.test_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'generated test cases are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
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
CREATE TRIGGER test_case_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.test_case_proposals
  FOR EACH ROW EXECUTE FUNCTION public.test_generation_output_guard();
CREATE TRIGGER test_generation_issues_guard BEFORE INSERT OR UPDATE OR DELETE ON public.test_generation_issues
  FOR EACH ROW EXECUTE FUNCTION public.test_generation_output_guard();

CREATE OR REPLACE FUNCTION public.test_generation_stage_results_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.test_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'test-generation stage results are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  -- reused_from_run_id may only be cleared by its FK (ON DELETE SET NULL).
  IF (to_jsonb(NEW) - 'reused_from_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reused_from_run_id') OR NEW.reused_from_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'test-generation stage results are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_generation_stage_results_immutable BEFORE UPDATE OR DELETE ON public.test_generation_stage_results
  FOR EACH ROW EXECUTE FUNCTION public.test_generation_stage_results_immutable();

-- A run is history: never deleted except with its whole project, identity
-- and input fixed when queued, a finished run never changes (same as 043).
CREATE OR REPLACE FUNCTION public.test_generation_runs_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
      RAISE EXCEPTION 'test generation runs are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.requirement_id <> OLD.requirement_id OR NEW.ac_ids <> OLD.ac_ids
     OR NEW.model <> OLD.model OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.input_sha256 <> OLD.input_sha256
     OR NEW.allowed_fragment_ids <> OLD.allowed_fragment_ids OR NEW.extraction_job_ids <> OLD.extraction_job_ids
     OR NEW.human_clarification_ids <> OLD.human_clarification_ids OR NEW.analysis_clarification_ids <> OLD.analysis_clarification_ids
     OR NEW.scope_note_ids <> OLD.scope_note_ids OR NEW.resolved_issue_ids <> OLD.resolved_issue_ids OR NEW.open_issue_ids <> OLD.open_issue_ids THEN
    RAISE EXCEPTION 'a test generation run''s Requirement, acceptance criteria, input and model are fixed when it is queued';
  END IF;
  IF OLD.status IN ('Completed', 'Completed with warnings', 'Failed')
     AND (to_jsonb(NEW) - 'worker_id' - 'requested_by' - 'retry_of_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'worker_id' - 'requested_by' - 'retry_of_run_id') THEN
    RAISE EXCEPTION 'a finished test generation run cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_generation_runs_guard BEFORE UPDATE OR DELETE ON public.test_generation_runs
  FOR EACH ROW EXECUTE FUNCTION public.test_generation_runs_guard();

-- ── Eligibility and the exact input (single source of truth) ───────────────

-- For one Requirement and a set of its ACs (NULL = all of them): is it
-- eligible, and if so the exact governed context. Never reads test_cases or
-- artefact_links.
CREATE OR REPLACE FUNCTION public.test_generation_input(p_project_id uuid, p_requirement_id uuid, p_ac_ids uuid[])
RETURNS TABLE (eligible boolean, reason text, ac_ids uuid[], allowed_fragment_ids uuid[], extraction_job_ids uuid[], human_clarification_ids uuid[],
  analysis_clarification_ids uuid[], scope_note_ids uuid[], resolved_issue_ids uuid[], open_issue_ids uuid[], snapshot jsonb)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_req public.requirements%ROWTYPE;
  v_rp public.requirement_proposals%ROWTYPE;
  v_rp_job uuid;
  v_acs jsonb := '[]'::jsonb;
  v_a record;
  v_p public.acceptance_criterion_proposals%ROWTYPE;
  v_job uuid;
  v_frag uuid[] := '{}';
  v_jobs uuid[] := '{}';
  v_h uuid[] := '{}'; v_c uuid[] := '{}'; v_n uuid[] := '{}'; v_r uuid[] := '{}'; v_o uuid[] := '{}';
  v_ac_h uuid[]; v_ac_r uuid[]; v_ac_o uuid[];
  v_missing integer;
BEGIN
  eligible := false;
  SELECT * INTO v_req FROM public.requirements q WHERE q.id = p_requirement_id AND q.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requirement not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF p_ac_ids IS NOT NULL AND cardinality(p_ac_ids) > 50 THEN
    reason := 'Choose at most 50 acceptance criteria for one test generation run.'; RETURN NEXT; RETURN;
  END IF;
  ac_ids := ARRAY(SELECT a.id FROM public.acceptance_criteria a
    WHERE a.requirement_id = v_req.id AND a.project_id = p_project_id AND (p_ac_ids IS NULL OR a.id = ANY (p_ac_ids))
    ORDER BY a.ac_ref, a.id);
  IF p_ac_ids IS NOT NULL AND cardinality(ac_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_ac_ids) x) THEN
    reason := 'Every selected acceptance criterion must belong to this Requirement in this project.'; RETURN NEXT; RETURN;
  END IF;
  IF cardinality(ac_ids) = 0 THEN
    reason := 'This Requirement has no acceptance criteria to design tests from.'; RETURN NEXT; RETURN;
  END IF;
  IF cardinality(ac_ids) > 50 THEN
    reason := 'This Requirement has more than 50 acceptance criteria; choose at most 50 for one run.'; RETURN NEXT; RETURN;
  END IF;

  -- The Requirement's own source provenance, when it was promoted from analysis.
  SELECT * INTO v_rp FROM public.requirement_proposals p WHERE p.promoted_record_id = v_req.id AND p.project_id = p_project_id AND p.review_status = 'Promoted';
  IF FOUND THEN
    SELECT r.extraction_job_id INTO v_rp_job FROM public.analysis_runs r WHERE r.id = v_rp.analysis_run_id;
    SELECT count(*) INTO v_missing FROM unnest(v_rp.source_fragment_ids) x
      WHERE NOT EXISTS (SELECT 1 FROM public.source_fragments f WHERE f.id = x AND f.extraction_job_id = v_rp_job);
    IF v_rp_job IS NULL OR v_missing > 0 THEN
      reason := 'The Requirement''s source provenance is incomplete, so tests cannot be designed safely.'; RETURN NEXT; RETURN;
    END IF;
    v_frag := v_rp.source_fragment_ids;
    v_jobs := ARRAY[v_rp_job];
  END IF;

  FOR v_a IN SELECT a.* FROM public.acceptance_criteria a WHERE a.id = ANY (ac_ids) ORDER BY a.ac_ref, a.id LOOP
    v_ac_h := '{}'; v_ac_r := '{}'; v_ac_o := '{}';
    SELECT * INTO v_p FROM public.acceptance_criterion_proposals p WHERE p.promoted_ac_id = v_a.id AND p.project_id = p_project_id;
    IF FOUND THEN
      SELECT r.extraction_job_id INTO v_job FROM public.ac_generation_runs r WHERE r.id = v_p.generation_run_id;
      SELECT count(*) INTO v_missing FROM unnest(v_p.source_fragment_ids) x
        WHERE NOT EXISTS (SELECT 1 FROM public.source_fragments f WHERE f.id = x AND f.extraction_job_id = v_job);
      IF v_job IS NULL OR v_missing > 0 THEN
        reason := format('The source provenance of %s is incomplete, so tests cannot be designed safely.', v_a.ac_ref); RETURN NEXT; RETURN;
      END IF;
      v_frag := v_frag || v_p.source_fragment_ids;
      v_jobs := v_jobs || v_job;
      v_ac_h := ARRAY(SELECT c.id FROM public.ac_human_clarifications c WHERE c.proposal_id = v_p.id ORDER BY c.created_at, c.id);
      -- Questions this AC depended on: answered (fact, with the human answer) or still open (never a fact).
      v_ac_r := ARRAY(SELECT g.id FROM public.ac_generation_issues g WHERE g.generation_run_id = v_p.generation_run_id
        AND g.analysis_issue_ids && v_p.open_issue_ids AND g.status IN ('Resolved', 'Not Applicable') ORDER BY g.sequence);
      -- Open: blocking questions re-opened since, and the run's open Additional Coverage questions.
      v_ac_o := ARRAY(SELECT g.id FROM public.ac_generation_issues g WHERE g.generation_run_id = v_p.generation_run_id
        AND g.status IN ('Open', 'Accepted')
        AND ((g.analysis_issue_ids && v_p.open_issue_ids) OR g.relation = 'Additional Coverage') ORDER BY g.sequence);
      v_h := v_h || v_ac_h; v_c := v_c || v_p.clarification_issue_ids; v_n := v_n || v_p.scope_note_ids; v_r := v_r || v_ac_r; v_o := v_o || v_ac_o;
    END IF;
    v_acs := v_acs || jsonb_build_array(jsonb_build_object(
      'id', v_a.id, 'ref', v_a.ac_ref, 'criterion', v_a.criterion, 'description', v_a.description, 'status', v_a.status,
      'criterion_type', v_a.criterion_type, 'given_text', v_a.given_text, 'when_text', v_a.when_text, 'then_text', v_a.then_text,
      'origin', CASE WHEN v_p.id IS NOT NULL AND v_p.promoted_ac_id = v_a.id THEN 'ai' ELSE 'manual' END,
      'proposal_id', CASE WHEN v_p.promoted_ac_id = v_a.id THEN v_p.id END,
      'source_quote', CASE WHEN v_p.promoted_ac_id = v_a.id THEN v_p.source_quote END,
      'fragment_ids', to_jsonb(CASE WHEN v_p.promoted_ac_id = v_a.id THEN v_p.source_fragment_ids ELSE '{}'::uuid[] END),
      'human_clarification_ids', to_jsonb(v_ac_h),
      'analysis_clarification_ids', to_jsonb(CASE WHEN v_p.promoted_ac_id = v_a.id THEN v_p.clarification_issue_ids ELSE '{}'::uuid[] END),
      'scope_note_ids', to_jsonb(CASE WHEN v_p.promoted_ac_id = v_a.id THEN v_p.scope_note_ids ELSE '{}'::uuid[] END),
      'resolved_issue_ids', to_jsonb(v_ac_r), 'open_issue_ids', to_jsonb(v_ac_o)));
  END LOOP;

  -- Scope notes explicitly associated with this Requirement (046), acknowledged only.
  v_n := v_n || ARRAY(SELECT a.scope_note_id FROM public.ac_scope_note_requirements a JOIN public.analysis_scope_notes n ON n.id = a.scope_note_id
    WHERE a.requirement_id = v_req.id AND a.project_id = p_project_id AND n.acknowledged_at IS NOT NULL);

  allowed_fragment_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_frag) x ORDER BY 1);
  extraction_job_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_jobs) x WHERE x IS NOT NULL ORDER BY 1);
  human_clarification_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_h) x ORDER BY 1);
  analysis_clarification_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_c) x ORDER BY 1);
  scope_note_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_n) x ORDER BY 1);
  resolved_issue_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_r) x ORDER BY 1);
  -- A question answered for one AC is not "open" for the run.
  open_issue_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_o) x WHERE NOT x = ANY (resolved_issue_ids) ORDER BY 1);

  snapshot := jsonb_build_object(
    'requirement', jsonb_build_object('id', v_req.id, 'ref', v_req.requirement_ref, 'title', v_req.title, 'description', v_req.description,
      'category', v_req.category, 'priority', v_req.priority, 'status', v_req.status, 'promoted', v_rp.id IS NOT NULL,
      'source_quote', v_rp.source_quote, 'fragment_ids', to_jsonb(coalesce(v_rp.source_fragment_ids, '{}'::uuid[]))),
    'acceptance_criteria', v_acs,
    'fragment_ids', to_jsonb(allowed_fragment_ids),
    'human_clarifications', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'proposal_id', c.proposal_id, 'clarification', c.clarification, 'reason', c.reason,
      'created_by_name', c.created_by_name, 'created_at', c.created_at) ORDER BY c.created_at, c.id)
      FROM public.ac_human_clarifications c WHERE c.id = ANY (human_clarification_ids)), '[]'::jsonb),
    'analysis_clarifications', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'question', i.suggested_question, 'description', i.description,
      'resolution_note', i.resolution_note, 'reviewed_by_name', i.reviewed_by_name) ORDER BY i.sequence)
      FROM public.analysis_issues i WHERE i.id = ANY (analysis_clarification_ids) AND i.status IN ('Resolved', 'Accepted') AND nullif(btrim(i.resolution_note), '') IS NOT NULL), '[]'::jsonb),
    'scope_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'area', n.area, 'description', n.description, 'source_quote', n.source_quote,
      'associated', EXISTS (SELECT 1 FROM public.ac_scope_note_requirements a WHERE a.scope_note_id = n.id AND a.requirement_id = v_req.id)) ORDER BY n.sequence)
      FROM public.analysis_scope_notes n WHERE n.id = ANY (scope_note_ids)), '[]'::jsonb),
    'resolved_questions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'description', g.description, 'question', g.suggested_question,
      'status', g.status, 'resolution_note', g.resolution_note, 'reviewed_by_name', g.reviewed_by_name) ORDER BY g.sequence)
      FROM public.ac_generation_issues g WHERE g.id = ANY (resolved_issue_ids)), '[]'::jsonb),
    'open_questions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'description', g.description, 'question', g.suggested_question,
      'relation', g.relation, 'status', g.status) ORDER BY g.sequence)
      FROM public.ac_generation_issues g WHERE g.id = ANY (open_issue_ids)), '[]'::jsonb)
  );
  eligible := true;
  reason := NULL;
  RETURN NEXT;
END;
$$;

-- ── Work functions (service role only; called by /api routes) ─────────────

CREATE OR REPLACE FUNCTION public.queue_test_generation_run(p_project_id uuid, p_requirement_id uuid, p_ac_ids uuid[], p_model text, p_user_id uuid, p_user_name text, p_retry_of_run_id uuid)
RETURNS TABLE (run_id uuid, trigger text, input_sha256 text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_in record;
  v_retry public.test_generation_runs%ROWTYPE;
  v_ac_ids uuid[] := p_ac_ids;
  v_sha text;
BEGIN
  PERFORM 1 FROM public.requirements q WHERE q.id = p_requirement_id AND q.project_id = p_project_id FOR UPDATE;
  IF p_retry_of_run_id IS NOT NULL THEN
    SELECT * INTO v_retry FROM public.test_generation_runs r WHERE r.id = p_retry_of_run_id AND r.project_id = p_project_id;
    IF NOT FOUND OR v_retry.requirement_id <> p_requirement_id THEN
      RAISE EXCEPTION 'The run to retry does not belong to this Requirement' USING ERRCODE = '22023';
    END IF;
    IF v_retry.status <> 'Failed' THEN RAISE EXCEPTION 'Only a failed test generation run can be retried' USING ERRCODE = '55000'; END IF;
    v_ac_ids := coalesce(v_ac_ids, v_retry.ac_ids);
  END IF;
  SELECT * INTO v_in FROM public.test_generation_input(p_project_id, p_requirement_id, v_ac_ids);
  IF NOT v_in.eligible THEN RAISE EXCEPTION '%', v_in.reason USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.test_generation_runs r WHERE r.requirement_id = p_requirement_id AND r.status IN ('Queued', 'Running')) THEN
    RAISE EXCEPTION 'Test generation is already in progress for this Requirement' USING ERRCODE = '23505';
  END IF;
  v_sha := encode(sha256(convert_to(v_in.snapshot::text, 'UTF8')), 'hex');
  trigger := CASE WHEN p_retry_of_run_id IS NULL THEN 'manual' ELSE 'retry' END;
  INSERT INTO public.test_generation_runs (project_id, requirement_id, ac_ids, trigger, retry_of_run_id, requested_by, requested_by_name, model,
    input_snapshot, input_sha256, allowed_fragment_ids, extraction_job_ids, human_clarification_ids, analysis_clarification_ids, scope_note_ids, resolved_issue_ids, open_issue_ids)
  VALUES (p_project_id, p_requirement_id, v_in.ac_ids, trigger, p_retry_of_run_id, p_user_id, p_user_name, p_model,
    v_in.snapshot, v_sha, v_in.allowed_fragment_ids, v_in.extraction_job_ids, v_in.human_clarification_ids, v_in.analysis_clarification_ids,
    v_in.scope_note_ids, v_in.resolved_issue_ids, v_in.open_issue_ids)
  RETURNING id INTO run_id;
  input_sha256 := v_sha;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_test_generation_run(p_worker_id uuid, p_worker_name text, p_worker_version text, p_prompt_version text, p_prompt_sha256 text, p_schema_version text, p_lease_seconds integer)
RETURNS SETOF public.test_generation_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
BEGIN
  UPDATE public.test_generation_runs r SET
    status = CASE WHEN r.attempt_count >= r.max_attempts THEN 'Failed' ELSE 'Queued' END,
    completed_at = CASE WHEN r.attempt_count >= r.max_attempts THEN now() ELSE NULL END,
    error_category = CASE WHEN r.attempt_count >= r.max_attempts THEN 'worker_timeout' ELSE NULL END,
    error_message = CASE WHEN r.attempt_count >= r.max_attempts THEN 'The worker stopped responding repeatedly; retry when the worker is running.' ELSE NULL END,
    lease_expires_at = NULL
  WHERE r.status = 'Running' AND r.lease_expires_at < now();

  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.status = 'Queued' ORDER BY r.queued_at, r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE public.test_generation_runs r SET status = 'Running', started_at = coalesce(r.started_at, now()), attempt_count = r.attempt_count + 1,
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)),
    worker_id = p_worker_id, worker_name = p_worker_name, worker_version = p_worker_version,
    prompt_version = p_prompt_version, prompt_sha256 = p_prompt_sha256, schema_version = p_schema_version
  WHERE r.id = v_run.id RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_test_generation_run_owner(p_run_id uuid, p_worker_id uuid)
RETURNS public.test_generation_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id OR v_run.lease_expires_at < now() THEN
    RAISE EXCEPTION 'This test generation run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_test_generation_stage(p_run_id uuid, p_worker_id uuid, p_stage text, p_chunk_key text, p_input_hash text, p_attempts integer, p_reused_from uuid, p_output jsonb, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
  v_count integer;
BEGIN
  v_run := public.assert_test_generation_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_output) <> 'object' THEN RAISE EXCEPTION 'Stage output must be a JSON object' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.test_generation_stage_results (generation_run_id, stage, chunk_key, input_hash, model, prompt_version, attempts, reused_from_run_id, output)
  VALUES (p_run_id, p_stage, p_chunk_key, p_input_hash, v_run.model, v_run.prompt_version, greatest(p_attempts, 1), p_reused_from, p_output)
  ON CONFLICT (generation_run_id, stage, chunk_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.test_generation_runs r SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)) WHERE r.id = p_run_id;
  RETURN v_count = 1;
END;
$$;

-- Worker: finish its running run atomically. Review status is decided HERE.
CREATE OR REPLACE FUNCTION public.complete_test_generation_run(p_run_id uuid, p_worker_id uuid, p_model_digest text, p_proposals jsonb, p_issues jsonb, p_diagnostics jsonb, p_with_warnings boolean)
RETURNS TABLE (project_id uuid, requirement_id uuid, status text, proposal_count integer, issue_count integer, needs_review_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
  v_status text;
  v_p integer;
  v_i integer;
  v_nr integer;
BEGIN
  v_run := public.assert_test_generation_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_proposals) <> 'array' OR jsonb_typeof(p_issues) <> 'array' THEN
    RAISE EXCEPTION 'proposals and issues must be arrays' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.test_case_proposals x WHERE x.generation_run_id = p_run_id)
     OR EXISTS (SELECT 1 FROM public.test_generation_issues x WHERE x.generation_run_id = p_run_id) THEN
    RAISE EXCEPTION 'This test generation run already has output' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.test_case_proposals (generation_run_id, project_id, requirement_id, sequence, title, objective, preconditions, steps, expected_result,
    test_type, variation, basis, confidence, review_status, needs_review_reasons, source_ac_ids, source_fragment_ids, human_clarification_ids,
    analysis_clarification_ids, scope_note_ids, resolved_issue_ids, rationale, behaviours, consolidation)
  SELECT p_run_id, v_run.project_id, v_run.requirement_id, (p.ord)::integer, p.v->>'title', p.v->>'objective',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'preconditions', '[]'::jsonb))),
    p.v->'steps', p.v->>'expected_result', p.v->>'test_type', nullif(p.v->>'variation', ''), p.v->>'basis', p.v->>'confidence',
    CASE WHEN p.v->>'basis' = 'Inferred' OR p.v->>'confidence' = 'Low'
           OR jsonb_array_length(coalesce(p.v->'needs_review_reasons', '[]'::jsonb)) > 0 THEN 'Needs Review' ELSE 'Proposed' END,
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'needs_review_reasons', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'source_ac_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'human_clarification_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'analysis_clarification_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'scope_note_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'resolved_issue_ids', '[]'::jsonb)))::uuid[],
    p.v->>'rationale', coalesce(p.v->'behaviours', '[]'::jsonb), coalesce(p.v->'consolidation', '{}'::jsonb)
  FROM jsonb_array_elements(p_proposals) WITH ORDINALITY AS p(v, ord);
  GET DIAGNOSTICS v_p = ROW_COUNT;

  INSERT INTO public.test_generation_issues (generation_run_id, project_id, requirement_id, sequence, issue_type, severity, description, behaviour,
    suggested_question, ac_ids, source_fragment_ids, source_issue_ids)
  SELECT p_run_id, v_run.project_id, v_run.requirement_id, (i.ord)::integer, i.v->>'issue_type', i.v->>'severity', i.v->>'description', i.v->>'behaviour',
    i.v->>'suggested_question',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'ac_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'source_issue_ids', '[]'::jsonb)))::uuid[]
  FROM jsonb_array_elements(p_issues) WITH ORDINALITY AS i(v, ord);
  GET DIAGNOSTICS v_i = ROW_COUNT;

  SELECT count(*) INTO v_nr FROM public.test_case_proposals x WHERE x.generation_run_id = p_run_id AND x.review_status = 'Needs Review';
  v_status := CASE WHEN p_with_warnings THEN 'Completed with warnings' ELSE 'Completed' END;
  UPDATE public.test_generation_runs r SET status = v_status, completed_at = now(), lease_expires_at = NULL, model_digest = left(p_model_digest, 100),
    diagnostics = p_diagnostics, proposal_count = v_p, issue_count = v_i, needs_review_count = v_nr,
    warnings_count = coalesce(jsonb_array_length(p_diagnostics->'warnings'), 0)
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; requirement_id := v_run.requirement_id; status := v_status;
  proposal_count := v_p; issue_count := v_i; needs_review_count := v_nr;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_test_generation_run(p_run_id uuid, p_worker_id uuid, p_category text, p_message text, p_model_digest text, p_diagnostics jsonb)
RETURNS TABLE (project_id uuid, requirement_id uuid)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.test_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.test_generation_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'This test generation run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  UPDATE public.test_generation_runs r SET status = 'Failed', completed_at = now(), lease_expires_at = NULL,
    error_category = p_category, error_message = left(p_message, 1000), model_digest = left(p_model_digest, 100), diagnostics = p_diagnostics
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; requirement_id := v_run.requirement_id;
  RETURN NEXT;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.test_generation_input(uuid, uuid, uuid[])',
    'public.queue_test_generation_run(uuid, uuid, uuid[], text, uuid, text, uuid)',
    'public.claim_test_generation_run(uuid, text, text, text, text, text, integer)',
    'public.assert_test_generation_run_owner(uuid, uuid)',
    'public.record_test_generation_stage(uuid, uuid, text, text, text, integer, uuid, jsonb, integer)',
    'public.complete_test_generation_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean)',
    'public.fail_test_generation_run(uuid, uuid, text, text, text, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.test_generation_output_guard()', 'public.test_generation_stage_results_immutable()', 'public.test_generation_runs_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.test_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_generation_stage_results ENABLE ROW LEVEL SECURITY;  -- no policies: service role only
ALTER TABLE public.test_case_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_generation_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "test_generation_runs_select" ON public.test_generation_runs FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "test_case_proposals_select" ON public.test_case_proposals FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "test_generation_issues_select" ON public.test_generation_issues FOR SELECT TO authenticated USING ((SELECT public.can_write()));
REVOKE ALL ON public.test_generation_runs, public.test_generation_stage_results, public.test_case_proposals, public.test_generation_issues FROM anon;
REVOKE ALL ON public.test_generation_stage_results FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.test_generation_runs, public.test_case_proposals, public.test_generation_issues FROM authenticated;
