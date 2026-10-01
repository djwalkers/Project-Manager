-- 043: AI Acceptance Criteria generation (Phase 1E) — GENERATION ONLY.
--
--   requirements (promoted) ──1:n── ac_generation_runs ──1:n── ac_generation_stage_results
--                                                      ├─1:n── acceptance_criterion_proposals
--                                                      └─1:n── ac_generation_issues
--
-- * Eligible: a canonical Requirement promoted from an AI proposal (the
--   proposal is Promoted and points at it), not signed off (Approved /
--   Complete / Closed — lib/lifecycle/requirement.ts), whose promoted
--   proposal's source fragments all still exist in its extraction run.
--   Manually-created Requirements are not eligible in Phase 1E.
-- * The input is fixed when the run is queued (ac_generation_input): the
--   Requirement, the promoted proposal (reviewed + original wording), the
--   proposal's OWN source fragments, the human resolutions of related
--   analysis issues (clarifications), related issues still open (questions,
--   never facts — related = tied to the proposal or its split/merge
--   ancestors, or tied to no proposal and sharing its source fragments),
--   and acknowledged scope notes that share the proposal's source
--   fragments. The run stores the allowed id sets and a snapshot of
--   the text with its SHA-256, so the run is reproducible.
-- * Generation runs on the existing local worker against the configured
--   LOCAL Ollama model, after extraction and requirement analysis. Same
--   narrow worker token, lease/retry pattern and stage reuse as Phase 1C.
-- * Output is NON-AUTHORITATIVE: acceptance_criterion_proposals and
--   ac_generation_issues are proposals for human review in a later phase.
--   Nothing here writes to acceptance_criteria (or any canonical record),
--   proposals carry no ac_ref, and the database — never the model — sets
--   review_status: Inferred, Low confidence, depending on an open question
--   or flagged by a deterministic check → 'Needs Review'.
-- * Provenance is enforced by the database: every proposal cites a source
--   fragment, an acknowledged scope note or a human clarification, and
--   every cited id must be one the run was given.
-- * Reads: Manager/Admin only (can_write). Writes: service role only, via
--   the functions below. anon: nothing.

-- ── Generation runs ────────────────────────────────────────────────────────

CREATE TABLE public.ac_generation_runs (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid        NOT NULL,
  requirement_id          uuid        NOT NULL,
  requirement_proposal_id uuid        NOT NULL REFERENCES public.requirement_proposals(id) ON DELETE CASCADE,
  analysis_run_id         uuid        NOT NULL,
  extraction_job_id       uuid        NOT NULL,
  status                  text        NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Running', 'Completed', 'Completed with warnings', 'Failed')),
  trigger                 text        NOT NULL CHECK (trigger IN ('manual', 'retry')),
  retry_of_run_id         uuid        REFERENCES public.ac_generation_runs(id) ON DELETE SET NULL,
  requested_by            uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name       text,
  queued_at               timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  completed_at            timestamptz,
  lease_expires_at        timestamptz,
  attempt_count           integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts            integer     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  worker_id               uuid        REFERENCES public.worker_credentials(id) ON DELETE SET NULL,
  worker_name             text,
  worker_version          text,
  model                   text        NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'),
  model_digest            text,
  prompt_version          text,
  prompt_sha256           text        CHECK (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version          text,
  input_snapshot          jsonb       NOT NULL,
  input_sha256            text        NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  allowed_fragment_ids    uuid[]      NOT NULL CHECK (cardinality(allowed_fragment_ids) >= 1),
  clarification_issue_ids uuid[]      NOT NULL DEFAULT '{}',
  open_issue_ids          uuid[]      NOT NULL DEFAULT '{}',
  scope_note_ids          uuid[]      NOT NULL DEFAULT '{}',
  proposal_count          integer,
  issue_count             integer,
  needs_review_count      integer,
  warnings_count          integer,
  diagnostics             jsonb,
  error_category          text        CHECK (error_category IN ('ollama_unreachable', 'model_unavailable', 'invalid_model_output', 'validation_failed', 'context_too_large', 'model_timeout', 'worker_timeout', 'upload_failed', 'internal_error')),
  error_message           text        CHECK (length(error_message) <= 1000),
  CONSTRAINT ac_generation_runs_requirement_fkey FOREIGN KEY (requirement_id, project_id) REFERENCES public.requirements (id, project_id) ON DELETE CASCADE,
  CONSTRAINT ac_generation_runs_analysis_fkey FOREIGN KEY (analysis_run_id, project_id) REFERENCES public.analysis_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT ac_generation_runs_id_project_key UNIQUE (id, project_id),
  CONSTRAINT ac_generation_runs_completed_shape CHECK (status NOT IN ('Completed', 'Completed with warnings')
    OR (completed_at IS NOT NULL AND prompt_version IS NOT NULL AND schema_version IS NOT NULL AND proposal_count IS NOT NULL AND issue_count IS NOT NULL)),
  CONSTRAINT ac_generation_runs_failed_shape CHECK (status <> 'Failed' OR (error_category IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ac_generation_runs_one_active_per_requirement ON public.ac_generation_runs (requirement_id) WHERE status IN ('Queued', 'Running');
CREATE INDEX ac_generation_runs_queue_idx ON public.ac_generation_runs (status, queued_at);
CREATE INDEX ac_generation_runs_requirement_idx ON public.ac_generation_runs (requirement_id, queued_at DESC);

-- ── Stage results (resumable, insert-only; same contract as 038) ─────────

CREATE TABLE public.ac_generation_stage_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id  uuid        NOT NULL REFERENCES public.ac_generation_runs(id) ON DELETE CASCADE,
  stage              text        NOT NULL CHECK (stage IN ('obligations', 'criteria', 'coverage')),
  chunk_key          text        NOT NULL CHECK (chunk_key ~ '^[A-Za-z0-9:._-]{1,80}$'),
  input_hash         text        NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  model              text        NOT NULL,
  prompt_version     text        NOT NULL,
  attempts           integer     NOT NULL CHECK (attempts >= 1),
  reused_from_run_id uuid        REFERENCES public.ac_generation_runs(id) ON DELETE SET NULL,
  output             jsonb       NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ac_generation_stage_results_key UNIQUE (generation_run_id, stage, chunk_key)
);

-- ── Proposals and generation issues (non-authoritative) ────────────────────

CREATE TABLE public.acceptance_criterion_proposals (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id       uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  requirement_id          uuid        NOT NULL,
  sequence                integer     NOT NULL CHECK (sequence >= 1),
  criterion               text        NOT NULL CHECK (length(criterion) BETWEEN 1 AND 2000),
  given_text              text        CHECK (length(given_text) <= 1000),
  when_text               text        CHECK (length(when_text) <= 1000),
  then_text               text        CHECK (length(then_text) <= 1000),
  criterion_type          text        NOT NULL CHECK (criterion_type IN ('Positive', 'Negative', 'Regression')),
  basis                   text        NOT NULL CHECK (basis IN ('Explicit', 'Inferred')),
  confidence              text        NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
  review_status           text        NOT NULL CHECK (review_status IN ('Proposed', 'Needs Review', 'Approved', 'Rejected', 'Promoted', 'Superseded')),
  needs_review_reasons    text[]      NOT NULL DEFAULT '{}',
  source_fragment_ids     uuid[]      NOT NULL DEFAULT '{}',
  scope_note_ids          uuid[]      NOT NULL DEFAULT '{}',
  clarification_issue_ids uuid[]      NOT NULL DEFAULT '{}',
  open_issue_ids          uuid[]      NOT NULL DEFAULT '{}',
  source_quote            text        CHECK (length(source_quote) <= 2000),
  rationale               text        NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  obligations             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  consolidation           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acceptance_criterion_proposals_run_fkey FOREIGN KEY (generation_run_id, project_id) REFERENCES public.ac_generation_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT acceptance_criterion_proposals_run_sequence_key UNIQUE (generation_run_id, sequence),
  CONSTRAINT acceptance_criterion_proposals_provenance CHECK (cardinality(source_fragment_ids) + cardinality(scope_note_ids) + cardinality(clarification_issue_ids) >= 1),
  CONSTRAINT acceptance_criterion_proposals_needs_review CHECK (
    review_status <> 'Proposed' OR (basis = 'Explicit' AND confidence <> 'Low' AND cardinality(open_issue_ids) = 0 AND cardinality(needs_review_reasons) = 0))
);
CREATE INDEX acceptance_criterion_proposals_run_idx ON public.acceptance_criterion_proposals (generation_run_id, sequence);
CREATE INDEX acceptance_criterion_proposals_requirement_idx ON public.acceptance_criterion_proposals (requirement_id);

CREATE TABLE public.ac_generation_issues (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id   uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  requirement_id      uuid        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),
  issue_type          text        NOT NULL CHECK (issue_type IN ('Missing Testable Outcome', 'Missing Preconditions', 'Ambiguous Expected Result', 'Unresolved Existing Analysis Issue', 'Conflicting Source/Resolution', 'Insufficient Source Support')),
  severity            text        NOT NULL CHECK (severity IN ('High', 'Medium', 'Low')),
  description         text        NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  obligation          text        CHECK (length(obligation) <= 1000),
  suggested_question  text        CHECK (length(suggested_question) <= 1000),
  source_fragment_ids uuid[]      NOT NULL DEFAULT '{}',
  analysis_issue_ids  uuid[]      NOT NULL DEFAULT '{}',
  related_proposal_sequences integer[] NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Not Applicable')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ac_generation_issues_run_fkey FOREIGN KEY (generation_run_id, project_id) REFERENCES public.ac_generation_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT ac_generation_issues_run_sequence_key UNIQUE (generation_run_id, sequence)
);
CREATE INDEX ac_generation_issues_run_idx ON public.ac_generation_issues (generation_run_id, sequence);

-- ── Guards ─────────────────────────────────────────────────────────────────

-- Every cited id must be one the run was given; requirement matches the run.
CREATE OR REPLACE FUNCTION public.ac_generation_output_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'generated acceptance criteria and generation issues are immutable in Phase 1E (review comes later)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.ac_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'generated acceptance criteria are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = NEW.generation_run_id;
  IF NEW.requirement_id IS DISTINCT FROM v_run.requirement_id THEN
    RAISE EXCEPTION 'output must belong to the run''s Requirement' USING ERRCODE = '22023';
  END IF;
  IF NOT NEW.source_fragment_ids <@ v_run.allowed_fragment_ids THEN
    RAISE EXCEPTION 'every cited source fragment must be one supplied to the generation run' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'acceptance_criterion_proposals' THEN
    IF NOT NEW.scope_note_ids <@ v_run.scope_note_ids THEN
      RAISE EXCEPTION 'every cited scope note must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
    IF NOT NEW.clarification_issue_ids <@ v_run.clarification_issue_ids THEN
      RAISE EXCEPTION 'every cited clarification must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
    IF NOT NEW.open_issue_ids <@ v_run.open_issue_ids THEN
      RAISE EXCEPTION 'every cited open question must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT NEW.analysis_issue_ids <@ (v_run.open_issue_ids || v_run.clarification_issue_ids) THEN
      RAISE EXCEPTION 'every cited analysis issue must be one supplied to the generation run' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER acceptance_criterion_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.acceptance_criterion_proposals
  FOR EACH ROW EXECUTE FUNCTION public.ac_generation_output_guard();
CREATE TRIGGER ac_generation_issues_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ac_generation_issues
  FOR EACH ROW EXECUTE FUNCTION public.ac_generation_output_guard();

CREATE OR REPLACE FUNCTION public.ac_generation_stage_results_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.ac_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'generation stage results are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  -- reused_from_run_id may only be cleared by its FK (ON DELETE SET NULL).
  IF (to_jsonb(NEW) - 'reused_from_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reused_from_run_id') OR NEW.reused_from_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'generation stage results are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ac_generation_stage_results_immutable BEFORE UPDATE OR DELETE ON public.ac_generation_stage_results
  FOR EACH ROW EXECUTE FUNCTION public.ac_generation_stage_results_immutable();

-- A run is history: never deleted except with its whole project, identity
-- and input fixed when queued, a finished run never changes.
CREATE OR REPLACE FUNCTION public.ac_generation_runs_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allowed only as part of a whole-project delete (the project row is gone
    -- by the time its cascade arrives, whichever path it takes).
    IF EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
      RAISE EXCEPTION 'acceptance criteria generation runs are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.requirement_id <> OLD.requirement_id
     OR NEW.requirement_proposal_id <> OLD.requirement_proposal_id OR NEW.analysis_run_id <> OLD.analysis_run_id
     OR NEW.extraction_job_id <> OLD.extraction_job_id OR NEW.model <> OLD.model
     OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.input_sha256 <> OLD.input_sha256
     OR NEW.allowed_fragment_ids <> OLD.allowed_fragment_ids OR NEW.clarification_issue_ids <> OLD.clarification_issue_ids
     OR NEW.open_issue_ids <> OLD.open_issue_ids OR NEW.scope_note_ids <> OLD.scope_note_ids THEN
    RAISE EXCEPTION 'a generation run''s Requirement, input and model are fixed when it is queued';
  END IF;
  IF OLD.status IN ('Completed', 'Completed with warnings', 'Failed')
     AND (to_jsonb(NEW) - 'worker_id' - 'requested_by' - 'retry_of_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'worker_id' - 'requested_by' - 'retry_of_run_id') THEN
    RAISE EXCEPTION 'a finished generation run cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ac_generation_runs_guard BEFORE UPDATE OR DELETE ON public.ac_generation_runs
  FOR EACH ROW EXECUTE FUNCTION public.ac_generation_runs_guard();

-- ── Eligibility and the exact input (single source of truth) ───────────────

-- For one Requirement: is it eligible, and if so the exact context the run
-- would be given. Used by queue_ac_generation_run and by the read route.
CREATE OR REPLACE FUNCTION public.ac_generation_input(p_project_id uuid, p_requirement_id uuid)
RETURNS TABLE (eligible boolean, reason text, requirement_proposal_id uuid, analysis_run_id uuid, extraction_job_id uuid,
  allowed_fragment_ids uuid[], clarification_issue_ids uuid[], open_issue_ids uuid[], scope_note_ids uuid[], snapshot jsonb)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_req public.requirements%ROWTYPE;
  v_p public.requirement_proposals%ROWTYPE;
  v_run public.analysis_runs%ROWTYPE;
  v_lineage integer[];
  v_found integer;
BEGIN
  eligible := false;
  SELECT * INTO v_req FROM public.requirements q WHERE q.id = p_requirement_id AND q.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requirement not found in this project' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_p FROM public.requirement_proposals p
    WHERE p.promoted_record_id = v_req.id AND p.project_id = p_project_id AND p.review_status = 'Promoted';
  IF NOT FOUND THEN
    reason := 'Only Requirements promoted from an approved AI proposal can generate acceptance criteria (manually-created Requirements are not supported yet).';
    RETURN NEXT; RETURN;
  END IF;
  requirement_proposal_id := v_p.id;
  IF lower(btrim(coalesce(v_req.status, ''))) IN ('approved', 'complete', 'closed') THEN
    reason := format('This Requirement is %s (signed off); acceptance criteria are generated only for Requirements still in progress.', v_req.status);
    RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_run FROM public.analysis_runs r WHERE r.id = v_p.analysis_run_id;
  SELECT count(DISTINCT f.id) INTO v_found FROM public.source_fragments f
    WHERE f.id = ANY (v_p.source_fragment_ids) AND f.extraction_job_id = v_run.extraction_job_id;
  IF v_run.id IS NULL OR v_found <> (SELECT count(DISTINCT x) FROM unnest(v_p.source_fragment_ids) x) THEN
    reason := 'The promoted proposal''s source provenance is incomplete, so acceptance criteria cannot be generated safely.';
    RETURN NEXT; RETURN;
  END IF;
  analysis_run_id := v_run.id;
  extraction_job_id := v_run.extraction_job_id;
  allowed_fragment_ids := ARRAY(SELECT x FROM unnest(v_p.source_fragment_ids) WITH ORDINALITY u(x, o) ORDER BY o);

  -- The promoted proposal and its split/merge ancestors (same run).
  WITH RECURSIVE lineage(id, sequence, parents) AS (
    SELECT v_p.id, v_p.sequence, v_p.parent_proposal_ids
    UNION
    SELECT p.id, p.sequence, p.parent_proposal_ids FROM public.requirement_proposals p JOIN lineage l ON p.id = ANY (l.parents)
    WHERE p.analysis_run_id = v_p.analysis_run_id
  )
  SELECT array_agg(DISTINCT l.sequence) INTO v_lineage FROM lineage l;

  -- Analysis issues of the same run about this proposal: an issue tied to
  -- proposals counts for those proposals' lineage only; an issue tied to no
  -- proposal counts where it shares the proposal's source fragments.
  -- A human resolution (Resolved/Accepted with a note) is a clarification;
  -- an issue still Open (or Accepted without an answer) is an open question.
  clarification_issue_ids := ARRAY(
    SELECT i.id FROM public.analysis_issues i
    WHERE i.analysis_run_id = v_p.analysis_run_id AND i.issue_type <> 'Out of Scope / Administrative Content'
      AND (i.related_proposal_sequences && v_lineage OR (cardinality(i.related_proposal_sequences) = 0 AND i.source_fragment_ids && v_p.source_fragment_ids))
      AND i.status IN ('Resolved', 'Accepted') AND nullif(btrim(i.resolution_note), '') IS NOT NULL
    ORDER BY i.sequence);
  open_issue_ids := ARRAY(
    SELECT i.id FROM public.analysis_issues i
    WHERE i.analysis_run_id = v_p.analysis_run_id AND i.issue_type <> 'Out of Scope / Administrative Content'
      AND (i.related_proposal_sequences && v_lineage OR (cardinality(i.related_proposal_sequences) = 0 AND i.source_fragment_ids && v_p.source_fragment_ids))
      AND (i.status = 'Open' OR (i.status = 'Accepted' AND nullif(btrim(i.resolution_note), '') IS NULL))
    ORDER BY i.sequence);
  -- Acknowledged scope/regression notes that share the proposal's source.
  scope_note_ids := ARRAY(
    SELECT n.id FROM public.analysis_scope_notes n
    WHERE n.analysis_run_id = v_p.analysis_run_id AND n.acknowledged_at IS NOT NULL AND n.source_fragment_ids && v_p.source_fragment_ids
    ORDER BY n.sequence);

  snapshot := jsonb_build_object(
    'requirement', jsonb_build_object('id', v_req.id, 'ref', v_req.requirement_ref, 'title', v_req.title, 'description', v_req.description,
      'category', v_req.category, 'priority', v_req.priority, 'status', v_req.status),
    'proposal', jsonb_build_object('id', v_p.id, 'sequence', v_p.sequence, 'origin', v_p.origin,
      'title', coalesce(v_p.reviewed_title, v_p.proposed_title), 'description', coalesce(v_p.reviewed_description, v_p.proposed_description),
      'original_title', v_p.proposed_title, 'original_description', v_p.proposed_description,
      'edited', (v_p.reviewed_title IS NOT NULL OR v_p.reviewed_description IS NOT NULL),
      'source_quote', v_p.source_quote, 'evidence_basis', v_p.evidence_basis,
      -- Verbatim quotes of the proposal and its consolidated members: they
      -- anchor which sentences of the cited fragments state THIS requirement.
      'source_quotes', to_jsonb(ARRAY(SELECT DISTINCT q FROM (
        SELECT v_p.source_quote AS q UNION ALL
        SELECT m->>'quote' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_p.consolidation->'members') = 'array' THEN v_p.consolidation->'members' ELSE '[]'::jsonb END) m
      ) x WHERE nullif(btrim(q), '') IS NOT NULL))),
    'document', (SELECT jsonb_build_object('id', d.id, 'name', d.document_name, 'type', d.document_type) FROM public.documents d WHERE d.id = v_run.document_id),
    'version', (SELECT jsonb_build_object('id', v.id, 'version_number', v.version_number, 'original_filename', v.original_filename) FROM public.document_versions v WHERE v.id = v_run.document_version_id),
    'extraction_job', (SELECT jsonb_build_object('id', j.id, 'extractor_version', j.extractor_version) FROM public.extraction_jobs j WHERE j.id = v_run.extraction_job_id),
    'fragment_ids', to_jsonb(allowed_fragment_ids),
    'clarifications', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'sequence', i.sequence, 'issue_type', i.issue_type, 'question', i.suggested_question,
      'description', i.description, 'status', i.status, 'resolution_note', i.resolution_note, 'reviewed_by_name', i.reviewed_by_name, 'reviewed_at', i.reviewed_at) ORDER BY i.sequence)
      FROM public.analysis_issues i WHERE i.id = ANY (clarification_issue_ids)), '[]'::jsonb),
    'open_questions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'sequence', i.sequence, 'issue_type', i.issue_type, 'question', i.suggested_question,
      'description', i.description, 'status', i.status) ORDER BY i.sequence)
      FROM public.analysis_issues i WHERE i.id = ANY (open_issue_ids)), '[]'::jsonb),
    'scope_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'sequence', n.sequence, 'note_type', n.note_type, 'area', n.area, 'description', n.description,
      'source_quote', n.source_quote, 'acknowledgement_note', n.acknowledgement_note, 'acknowledged_by_name', n.acknowledged_by_name) ORDER BY n.sequence)
      FROM public.analysis_scope_notes n WHERE n.id = ANY (scope_note_ids)), '[]'::jsonb)
  );
  eligible := true;
  reason := NULL;
  RETURN NEXT;
END;
$$;

-- ── Work functions (service role only; called by /api routes) ─────────────

CREATE OR REPLACE FUNCTION public.queue_ac_generation_run(p_project_id uuid, p_requirement_id uuid, p_model text, p_user_id uuid, p_user_name text, p_retry_of_run_id uuid)
RETURNS TABLE (run_id uuid, trigger text, input_sha256 text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_in record;
  v_retry public.ac_generation_runs%ROWTYPE;
  v_sha text;
BEGIN
  PERFORM 1 FROM public.requirements q WHERE q.id = p_requirement_id AND q.project_id = p_project_id FOR UPDATE;
  SELECT * INTO v_in FROM public.ac_generation_input(p_project_id, p_requirement_id);
  IF NOT v_in.eligible THEN RAISE EXCEPTION '%', v_in.reason USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.ac_generation_runs r WHERE r.requirement_id = p_requirement_id AND r.status IN ('Queued', 'Running')) THEN
    RAISE EXCEPTION 'Acceptance criteria generation is already in progress for this Requirement' USING ERRCODE = '23505';
  END IF;
  IF p_retry_of_run_id IS NOT NULL THEN
    SELECT * INTO v_retry FROM public.ac_generation_runs r WHERE r.id = p_retry_of_run_id AND r.project_id = p_project_id;
    IF NOT FOUND OR v_retry.requirement_id <> p_requirement_id THEN
      RAISE EXCEPTION 'The run to retry does not belong to this Requirement' USING ERRCODE = '22023';
    END IF;
    IF v_retry.status <> 'Failed' THEN RAISE EXCEPTION 'Only a failed generation run can be retried' USING ERRCODE = '55000'; END IF;
  END IF;
  v_sha := encode(sha256(convert_to(v_in.snapshot::text, 'UTF8')), 'hex');
  trigger := CASE WHEN p_retry_of_run_id IS NULL THEN 'manual' ELSE 'retry' END;
  INSERT INTO public.ac_generation_runs (project_id, requirement_id, requirement_proposal_id, analysis_run_id, extraction_job_id, trigger, retry_of_run_id,
    requested_by, requested_by_name, model, input_snapshot, input_sha256, allowed_fragment_ids, clarification_issue_ids, open_issue_ids, scope_note_ids)
  VALUES (p_project_id, p_requirement_id, v_in.requirement_proposal_id, v_in.analysis_run_id, v_in.extraction_job_id, trigger, p_retry_of_run_id,
    p_user_id, p_user_name, p_model, v_in.snapshot, v_sha, v_in.allowed_fragment_ids, v_in.clarification_issue_ids, v_in.open_issue_ids, v_in.scope_note_ids)
  RETURNING id INTO run_id;
  input_sha256 := v_sha;
  RETURN NEXT;
END;
$$;

-- Worker: claim the oldest queued run (expired leases re-queued, or failed
-- as worker_timeout once max_attempts is reached) — same as 038.
CREATE OR REPLACE FUNCTION public.claim_ac_generation_run(p_worker_id uuid, p_worker_name text, p_worker_version text, p_prompt_version text, p_prompt_sha256 text, p_schema_version text, p_lease_seconds integer)
RETURNS SETOF public.ac_generation_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  UPDATE public.ac_generation_runs r SET
    status = CASE WHEN r.attempt_count >= r.max_attempts THEN 'Failed' ELSE 'Queued' END,
    completed_at = CASE WHEN r.attempt_count >= r.max_attempts THEN now() ELSE NULL END,
    error_category = CASE WHEN r.attempt_count >= r.max_attempts THEN 'worker_timeout' ELSE NULL END,
    error_message = CASE WHEN r.attempt_count >= r.max_attempts THEN 'The worker stopped responding repeatedly; retry when the worker is running.' ELSE NULL END,
    lease_expires_at = NULL
  WHERE r.status = 'Running' AND r.lease_expires_at < now();

  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.status = 'Queued' ORDER BY r.queued_at, r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE public.ac_generation_runs r SET status = 'Running', started_at = coalesce(r.started_at, now()), attempt_count = r.attempt_count + 1,
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)),
    worker_id = p_worker_id, worker_name = p_worker_name, worker_version = p_worker_version,
    prompt_version = p_prompt_version, prompt_sha256 = p_prompt_sha256, schema_version = p_schema_version
  WHERE r.id = v_run.id RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_ac_generation_run_owner(p_run_id uuid, p_worker_id uuid)
RETURNS public.ac_generation_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id OR v_run.lease_expires_at < now() THEN
    RAISE EXCEPTION 'This generation run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_ac_generation_stage(p_run_id uuid, p_worker_id uuid, p_stage text, p_chunk_key text, p_input_hash text, p_attempts integer, p_reused_from uuid, p_output jsonb, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
  v_count integer;
BEGIN
  v_run := public.assert_ac_generation_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_output) <> 'object' THEN RAISE EXCEPTION 'Stage output must be a JSON object' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.ac_generation_stage_results (generation_run_id, stage, chunk_key, input_hash, model, prompt_version, attempts, reused_from_run_id, output)
  VALUES (p_run_id, p_stage, p_chunk_key, p_input_hash, v_run.model, v_run.prompt_version, greatest(p_attempts, 1), p_reused_from, p_output)
  ON CONFLICT (generation_run_id, stage, chunk_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.ac_generation_runs r SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)) WHERE r.id = p_run_id;
  RETURN v_count = 1;
END;
$$;

-- Worker: finish its running run atomically. Review status is decided HERE.
CREATE OR REPLACE FUNCTION public.complete_ac_generation_run(p_run_id uuid, p_worker_id uuid, p_model_digest text, p_proposals jsonb, p_issues jsonb, p_diagnostics jsonb, p_with_warnings boolean)
RETURNS TABLE (project_id uuid, requirement_id uuid, status text, proposal_count integer, issue_count integer, needs_review_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
  v_status text;
  v_p integer;
  v_i integer;
  v_nr integer;
BEGIN
  v_run := public.assert_ac_generation_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_proposals) <> 'array' OR jsonb_typeof(p_issues) <> 'array' THEN
    RAISE EXCEPTION 'proposals and issues must be arrays' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.acceptance_criterion_proposals x WHERE x.generation_run_id = p_run_id)
     OR EXISTS (SELECT 1 FROM public.ac_generation_issues x WHERE x.generation_run_id = p_run_id) THEN
    RAISE EXCEPTION 'This generation run already has output' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.acceptance_criterion_proposals (generation_run_id, project_id, requirement_id, sequence, criterion, given_text, when_text, then_text,
    criterion_type, basis, confidence, review_status, needs_review_reasons, source_fragment_ids, scope_note_ids, clarification_issue_ids, open_issue_ids,
    source_quote, rationale, obligations, consolidation)
  SELECT p_run_id, v_run.project_id, v_run.requirement_id, (p.ord)::integer, p.v->>'criterion', p.v->>'given_text', p.v->>'when_text', p.v->>'then_text',
    p.v->>'criterion_type', p.v->>'basis', p.v->>'confidence',
    CASE WHEN p.v->>'basis' = 'Inferred' OR p.v->>'confidence' = 'Low'
           OR jsonb_array_length(coalesce(p.v->'open_issue_ids', '[]'::jsonb)) > 0
           OR jsonb_array_length(coalesce(p.v->'needs_review_reasons', '[]'::jsonb)) > 0 THEN 'Needs Review' ELSE 'Proposed' END,
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'needs_review_reasons', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'scope_note_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'clarification_issue_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p.v->'open_issue_ids', '[]'::jsonb)))::uuid[],
    p.v->>'source_quote', p.v->>'rationale', coalesce(p.v->'obligations', '[]'::jsonb), coalesce(p.v->'consolidation', '{}'::jsonb)
  FROM jsonb_array_elements(p_proposals) WITH ORDINALITY AS p(v, ord);
  GET DIAGNOSTICS v_p = ROW_COUNT;

  INSERT INTO public.ac_generation_issues (generation_run_id, project_id, requirement_id, sequence, issue_type, severity, description, obligation,
    suggested_question, source_fragment_ids, analysis_issue_ids, related_proposal_sequences)
  SELECT p_run_id, v_run.project_id, v_run.requirement_id, (i.ord)::integer, i.v->>'issue_type', i.v->>'severity', i.v->>'description', i.v->>'obligation',
    i.v->>'suggested_question',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'analysis_issue_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'related_proposal_sequences', '[]'::jsonb)))::integer[]
  FROM jsonb_array_elements(p_issues) WITH ORDINALITY AS i(v, ord);
  GET DIAGNOSTICS v_i = ROW_COUNT;

  SELECT count(*) INTO v_nr FROM public.acceptance_criterion_proposals x WHERE x.generation_run_id = p_run_id AND x.review_status = 'Needs Review';
  v_status := CASE WHEN p_with_warnings THEN 'Completed with warnings' ELSE 'Completed' END;
  UPDATE public.ac_generation_runs r SET status = v_status, completed_at = now(), lease_expires_at = NULL, model_digest = left(p_model_digest, 100),
    diagnostics = p_diagnostics, proposal_count = v_p, issue_count = v_i, needs_review_count = v_nr,
    warnings_count = coalesce(jsonb_array_length(p_diagnostics->'warnings'), 0)
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; requirement_id := v_run.requirement_id; status := v_status;
  proposal_count := v_p; issue_count := v_i; needs_review_count := v_nr;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_ac_generation_run(p_run_id uuid, p_worker_id uuid, p_category text, p_message text, p_model_digest text, p_diagnostics jsonb)
RETURNS TABLE (project_id uuid, requirement_id uuid)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'This generation run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  UPDATE public.ac_generation_runs r SET status = 'Failed', completed_at = now(), lease_expires_at = NULL,
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
    'public.ac_generation_input(uuid, uuid)',
    'public.queue_ac_generation_run(uuid, uuid, text, uuid, text, uuid)',
    'public.claim_ac_generation_run(uuid, text, text, text, text, text, integer)',
    'public.assert_ac_generation_run_owner(uuid, uuid)',
    'public.record_ac_generation_stage(uuid, uuid, text, text, text, integer, uuid, jsonb, integer)',
    'public.complete_ac_generation_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean)',
    'public.fail_ac_generation_run(uuid, uuid, text, text, text, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.ac_generation_output_guard()', 'public.ac_generation_stage_results_immutable()', 'public.ac_generation_runs_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.ac_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_generation_stage_results ENABLE ROW LEVEL SECURITY;  -- no policies: service role only
ALTER TABLE public.acceptance_criterion_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_generation_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ac_generation_runs_select" ON public.ac_generation_runs FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "acceptance_criterion_proposals_select" ON public.acceptance_criterion_proposals FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "ac_generation_issues_select" ON public.ac_generation_issues FOR SELECT TO authenticated USING ((SELECT public.can_write()));
REVOKE ALL ON public.ac_generation_runs, public.ac_generation_stage_results, public.acceptance_criterion_proposals, public.ac_generation_issues FROM anon;
REVOKE ALL ON public.ac_generation_stage_results FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ac_generation_runs, public.acceptance_criterion_proposals, public.ac_generation_issues FROM authenticated;
