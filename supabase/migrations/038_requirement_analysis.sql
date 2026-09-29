-- 038: AI requirement analysis and ambiguity detection (Phase 1C).
--
--   extraction_job ──1:n── analysis_runs ──1:n── analysis_stage_results
--                                        ├─1:n── requirement_proposals
--                                        └─1:n── analysis_issues
--
-- * An analysis run analyses exactly ONE completed extraction job (its
--   immutable fragment set). The run records that extraction_job_id; a later
--   re-extraction creates a new job and never touches existing runs or the
--   fragments they cite.
-- * Analysis runs on the local worker (local-worker/) against a LOCAL Ollama
--   model. Document text never leaves the Mac for an external AI provider.
--   The worker uses the same narrow, revocable worker token as extraction;
--   it can claim a queued run, read the fragments of THAT run's extraction
--   job, record stage results and complete/fail THAT run. Nothing else.
-- * One active (Queued/Running) run per extraction job — partial unique
--   index. Runs are history: terminal runs are never edited or deleted on
--   their own; a retry is a NEW run (retry_of_run_id) that may reuse the
--   failed run's completed stage results.
-- * Output is NON-AUTHORITATIVE: requirement_proposals and analysis_issues
--   are proposals for human review. Nothing here writes to requirements,
--   acceptance_criteria, test_cases, actions, risks, decisions,
--   discovery_questions, ProjectState or Go-Live Readiness, and proposals
--   carry no requirement_ref (canonical references are generated only when
--   a proposal is promoted, later, through the existing creation paths).
-- * Provenance is enforced by the database: every proposal/issue cites at
--   least one fragment, every cited fragment belongs to the run's own
--   extraction job, and a proposal's primary fragment is one of its sources.
-- * Inferred requirements are always 'Needs Review' — the database sets
--   review_status; the model never supplies it.
-- * Reads: Manager/Admin only (can_write) — Viewer does not see proposals in
--   Phase 1C. Writes: service role only, via the functions below. anon: nothing.
-- * document_versions.analysis_status (035 placeholder) is left untouched:
--   analysis state lives on analysis_runs, so an analysis failure can never
--   change the source document or its version row.

-- ── Configurable analysis model ────────────────────────────────────────────

-- The Ollama model used for batch analysis (Admin-configurable in System
-- Health). NULL means the application default. Separate from `model`, which
-- is the conversational Project Assistant's model.
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS analysis_model text
  CHECK (analysis_model IS NULL OR analysis_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$');

-- What the worker last reported about its local Ollama (heartbeat):
-- {reachable, version, models:[{name, digest, family, parameter_size}]}.
ALTER TABLE public.worker_credentials ADD COLUMN IF NOT EXISTS last_seen_ollama jsonb;
ALTER TABLE public.worker_credentials ADD COLUMN IF NOT EXISTS last_seen_analysis_version text;

-- ── Analysis runs ──────────────────────────────────────────────────────────

CREATE TABLE public.analysis_runs (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid        NOT NULL,
  document_id             uuid        NOT NULL,
  document_version_id     uuid        NOT NULL,
  extraction_job_id       uuid        NOT NULL,
  status                  text        NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Running', 'Completed', 'Completed with warnings', 'Failed')),
  trigger                 text        NOT NULL CHECK (trigger IN ('manual', 'retry')),
  retry_of_run_id         uuid        REFERENCES public.analysis_runs(id) ON DELETE SET NULL,
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
  analysis_schema_version text,
  proposal_count          integer,
  issue_count             integer,
  warnings_count          integer,
  diagnostics             jsonb,
  error_category          text        CHECK (error_category IN ('ollama_unreachable', 'model_unavailable', 'invalid_model_output', 'validation_failed', 'context_too_large', 'model_timeout', 'worker_timeout', 'upload_failed', 'internal_error')),
  error_message           text        CHECK (length(error_message) <= 1000),
  CONSTRAINT analysis_runs_extraction_same_version_fkey
    FOREIGN KEY (extraction_job_id, document_version_id, project_id)
    REFERENCES public.extraction_jobs (id, document_version_id, project_id) ON DELETE CASCADE,
  CONSTRAINT analysis_runs_version_same_document_fkey
    FOREIGN KEY (document_version_id, document_id) REFERENCES public.document_versions (id, document_id) ON DELETE CASCADE,
  CONSTRAINT analysis_runs_id_project_key UNIQUE (id, project_id),
  CONSTRAINT analysis_runs_completed_shape CHECK (status NOT IN ('Completed', 'Completed with warnings')
    OR (completed_at IS NOT NULL AND prompt_version IS NOT NULL AND analysis_schema_version IS NOT NULL AND proposal_count IS NOT NULL AND issue_count IS NOT NULL)),
  CONSTRAINT analysis_runs_failed_shape CHECK (status <> 'Failed' OR (error_category IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX analysis_runs_one_active_per_extraction ON public.analysis_runs (extraction_job_id) WHERE status IN ('Queued', 'Running');
CREATE INDEX analysis_runs_queue_idx ON public.analysis_runs (status, queued_at);
CREATE INDEX analysis_runs_version_idx ON public.analysis_runs (document_version_id, queued_at DESC);
CREATE INDEX analysis_runs_project_idx ON public.analysis_runs (project_id, queued_at DESC);

-- ── Stage results (resumable, insert-only) ─────────────────────────────────

-- One validated model output per (run, stage, chunk). input_hash is the
-- SHA-256 of the exact prompt input, so a retry reuses a result only when
-- the input, model and prompt version are identical.
CREATE TABLE public.analysis_stage_results (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id  uuid        NOT NULL REFERENCES public.analysis_runs(id) ON DELETE CASCADE,
  stage            text        NOT NULL CHECK (stage IN ('classification', 'requirements', 'ambiguities', 'consolidation')),
  chunk_key        text        NOT NULL CHECK (chunk_key ~ '^[A-Za-z0-9:._-]{1,80}$'),
  input_hash       text        NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  model            text        NOT NULL,
  prompt_version   text        NOT NULL,
  attempts         integer     NOT NULL CHECK (attempts >= 1),
  reused_from_run_id uuid      REFERENCES public.analysis_runs(id) ON DELETE SET NULL,
  output           jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_stage_results_key UNIQUE (analysis_run_id, stage, chunk_key)
);

-- ── Proposals and issues (non-authoritative) ───────────────────────────────

CREATE TABLE public.requirement_proposals (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id            uuid        NOT NULL,
  project_id                 uuid        NOT NULL,
  sequence                   integer     NOT NULL CHECK (sequence >= 1),
  proposal_type              text        NOT NULL DEFAULT 'requirement' CHECK (proposal_type = 'requirement'),
  proposed_title             text        NOT NULL CHECK (length(proposed_title) BETWEEN 1 AND 300),
  proposed_description       text        NOT NULL CHECK (length(proposed_description) BETWEEN 1 AND 4000),
  proposed_category          text        CHECK (proposed_category IN ('Business Rule', 'Database', 'Backend', 'UI', 'Performance', 'Testing')),
  proposed_priority          text        CHECK (proposed_priority IN ('Low', 'Medium', 'High', 'Critical')),
  source_fragment_ids        uuid[]      NOT NULL CHECK (cardinality(source_fragment_ids) >= 1),
  primary_source_fragment_id uuid        NOT NULL,
  source_quote               text        CHECK (length(source_quote) <= 2000),
  rationale                  text        NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  evidence_basis             text        NOT NULL CHECK (evidence_basis IN ('Explicit', 'Inferred')),
  confidence                 text        NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
  review_status              text        NOT NULL CHECK (review_status IN ('Proposed', 'Needs Review', 'Approved', 'Rejected', 'Promoted', 'Superseded')),
  consolidation              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_proposals_run_fkey FOREIGN KEY (analysis_run_id, project_id) REFERENCES public.analysis_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT requirement_proposals_run_sequence_key UNIQUE (analysis_run_id, sequence),
  CONSTRAINT requirement_proposals_primary_is_source CHECK (primary_source_fragment_id = ANY (source_fragment_ids)),
  CONSTRAINT requirement_proposals_inferred_needs_review CHECK (evidence_basis <> 'Inferred' OR review_status <> 'Proposed')
);
CREATE INDEX requirement_proposals_run_idx ON public.requirement_proposals (analysis_run_id, sequence);

CREATE TABLE public.analysis_issues (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id     uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),
  issue_type          text        NOT NULL CHECK (issue_type IN ('Ambiguity', 'Missing Information', 'Contradiction', 'Untestable Statement', 'Assumption Required', 'Duplicate / Repeated Requirement', 'Out of Scope / Administrative Content')),
  severity            text        NOT NULL CHECK (severity IN ('High', 'Medium', 'Low')),
  description         text        NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  suggested_question  text        CHECK (length(suggested_question) <= 1000),
  source_fragment_ids uuid[]      NOT NULL CHECK (cardinality(source_fragment_ids) >= 1),
  related_proposal_sequences integer[] NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Accepted', 'Not Applicable')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_issues_run_fkey FOREIGN KEY (analysis_run_id, project_id) REFERENCES public.analysis_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT analysis_issues_run_sequence_key UNIQUE (analysis_run_id, sequence)
);
CREATE INDEX analysis_issues_run_idx ON public.analysis_issues (analysis_run_id, sequence);

-- ── Guards ─────────────────────────────────────────────────────────────────

-- Every cited fragment must belong to the run's own extraction job — the
-- model cannot cite fragments of another version, run or project.
CREATE OR REPLACE FUNCTION public.analysis_output_provenance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job uuid;
  v_found integer;
BEGIN
  SELECT r.extraction_job_id INTO v_job FROM public.analysis_runs r WHERE r.id = NEW.analysis_run_id;
  SELECT count(DISTINCT f.id) INTO v_found FROM public.source_fragments f
    WHERE f.id = ANY (NEW.source_fragment_ids) AND f.extraction_job_id = v_job;
  IF v_found <> (SELECT count(DISTINCT x) FROM unnest(NEW.source_fragment_ids) x) THEN
    RAISE EXCEPTION 'every cited source fragment must belong to the analysed extraction run' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_proposals_provenance BEFORE INSERT OR UPDATE OF source_fragment_ids, primary_source_fragment_id ON public.requirement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.analysis_output_provenance_guard();
CREATE TRIGGER analysis_issues_provenance BEFORE INSERT OR UPDATE OF source_fragment_ids ON public.analysis_issues
  FOR EACH ROW EXECUTE FUNCTION public.analysis_output_provenance_guard();

-- Generated content is fixed: after insert only the review status (Phase 1D)
-- may change. Runs are never re-pointed; terminal runs are history.
CREATE OR REPLACE FUNCTION public.analysis_output_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'requirement_proposals' THEN
    IF (to_jsonb(NEW) - 'review_status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'review_status' - 'updated_at') THEN
      RAISE EXCEPTION 'generated proposal content is immutable; only its review status may change';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'generated issue content is immutable; only its status may change';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_proposals_immutable BEFORE UPDATE ON public.requirement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.analysis_output_immutable();
CREATE TRIGGER analysis_issues_immutable BEFORE UPDATE ON public.analysis_issues
  FOR EACH ROW EXECUTE FUNCTION public.analysis_output_immutable();

CREATE OR REPLACE FUNCTION public.analysis_stage_results_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'analysis stage results are immutable'; END IF;
  IF EXISTS (SELECT 1 FROM public.analysis_runs r WHERE r.id = OLD.analysis_run_id) THEN
    RAISE EXCEPTION 'analysis stage results are history and cannot be deleted on their own';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER analysis_stage_results_immutable BEFORE UPDATE OR DELETE ON public.analysis_stage_results
  FOR EACH ROW EXECUTE FUNCTION public.analysis_stage_results_immutable();

CREATE OR REPLACE FUNCTION public.analysis_runs_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.extraction_jobs j WHERE j.id = OLD.extraction_job_id) THEN
      RAISE EXCEPTION 'analysis runs are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.extraction_job_id <> OLD.extraction_job_id OR NEW.document_version_id <> OLD.document_version_id
     OR NEW.document_id <> OLD.document_id OR NEW.project_id <> OLD.project_id OR NEW.model <> OLD.model THEN
    RAISE EXCEPTION 'an analysis run cannot be moved to another extraction run or model';
  END IF;
  IF OLD.status IN ('Completed', 'Completed with warnings', 'Failed')
     AND (to_jsonb(NEW) - 'worker_id' - 'requested_by' - 'retry_of_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'worker_id' - 'requested_by' - 'retry_of_run_id') THEN
    RAISE EXCEPTION 'a finished analysis run cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_runs_guard BEFORE UPDATE OR DELETE ON public.analysis_runs
  FOR EACH ROW EXECUTE FUNCTION public.analysis_runs_guard();

-- ── Work functions (service role only; called by /api routes) ─────────────

-- Manager/Admin: queue analysis of one completed extraction job of the
-- CURRENT version of a non-archived document. p_retry_of_run_id (a failed
-- run of the same extraction job) makes this a retry.
CREATE OR REPLACE FUNCTION public.queue_analysis_run(p_project_id uuid, p_extraction_job_id uuid, p_model text, p_user_id uuid, p_user_name text, p_retry_of_run_id uuid)
RETURNS TABLE (run_id uuid, trigger text, document_version_id uuid)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_job public.extraction_jobs%ROWTYPE;
  v_version public.document_versions%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_retry public.analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.extraction_jobs j WHERE j.id = p_extraction_job_id AND j.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extraction run not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v_job.status <> 'Completed' THEN
    RAISE EXCEPTION 'Only a completed extraction can be analysed' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_version FROM public.document_versions v WHERE v.id = v_job.document_version_id FOR UPDATE;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_version.document_id;
  IF v_doc.archived_at IS NOT NULL THEN RAISE EXCEPTION 'This source document is archived' USING ERRCODE = '55000'; END IF;
  IF v_doc.current_version_id <> v_version.id THEN
    RAISE EXCEPTION 'Only the current version of a document can be analysed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.analysis_runs r WHERE r.extraction_job_id = p_extraction_job_id AND r.status IN ('Queued', 'Running')) THEN
    RAISE EXCEPTION 'Analysis is already in progress for this extraction' USING ERRCODE = '23505';
  END IF;
  IF p_retry_of_run_id IS NOT NULL THEN
    SELECT * INTO v_retry FROM public.analysis_runs r WHERE r.id = p_retry_of_run_id AND r.project_id = p_project_id;
    IF NOT FOUND OR v_retry.extraction_job_id <> p_extraction_job_id THEN
      RAISE EXCEPTION 'The run to retry does not belong to this extraction' USING ERRCODE = '22023';
    END IF;
    IF v_retry.status <> 'Failed' THEN RAISE EXCEPTION 'Only a failed analysis run can be retried' USING ERRCODE = '55000'; END IF;
  END IF;
  trigger := CASE WHEN p_retry_of_run_id IS NULL THEN 'manual' ELSE 'retry' END;
  INSERT INTO public.analysis_runs (project_id, document_id, document_version_id, extraction_job_id, trigger, retry_of_run_id, requested_by, requested_by_name, model)
  VALUES (p_project_id, v_doc.id, v_version.id, v_job.id, trigger, p_retry_of_run_id, p_user_id, p_user_name, p_model)
  RETURNING id INTO run_id;
  document_version_id := v_version.id;
  RETURN NEXT;
END;
$$;

-- Worker: claim the oldest queued run (expired leases are re-queued, or
-- failed as worker_timeout once max_attempts is reached).
CREATE OR REPLACE FUNCTION public.claim_analysis_run(p_worker_id uuid, p_worker_name text, p_worker_version text, p_prompt_version text, p_prompt_sha256 text, p_schema_version text, p_lease_seconds integer)
RETURNS SETOF public.analysis_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.analysis_runs%ROWTYPE;
BEGIN
  UPDATE public.analysis_runs r SET
    status = CASE WHEN r.attempt_count >= r.max_attempts THEN 'Failed' ELSE 'Queued' END,
    completed_at = CASE WHEN r.attempt_count >= r.max_attempts THEN now() ELSE NULL END,
    error_category = CASE WHEN r.attempt_count >= r.max_attempts THEN 'worker_timeout' ELSE NULL END,
    error_message = CASE WHEN r.attempt_count >= r.max_attempts THEN 'The analysis worker stopped responding repeatedly; retry when the worker is running.' ELSE NULL END,
    lease_expires_at = NULL
  WHERE r.status = 'Running' AND r.lease_expires_at < now();

  SELECT * INTO v_run FROM public.analysis_runs r WHERE r.status = 'Queued' ORDER BY r.queued_at, r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE public.analysis_runs r SET status = 'Running', started_at = coalesce(r.started_at, now()), attempt_count = r.attempt_count + 1,
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)),
    worker_id = p_worker_id, worker_name = p_worker_name, worker_version = p_worker_version,
    prompt_version = p_prompt_version, prompt_sha256 = p_prompt_sha256, analysis_schema_version = p_schema_version
  WHERE r.id = v_run.id RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_analysis_run_owner(p_run_id uuid, p_worker_id uuid)
RETURNS public.analysis_runs
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.analysis_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id OR v_run.lease_expires_at < now() THEN
    RAISE EXCEPTION 'This analysis run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  RETURN v_run;
END;
$$;

-- Worker: persist one validated stage output (and extend the lease). A
-- repeated (run, stage, chunk) is a no-op, so a resumed worker is idempotent.
CREATE OR REPLACE FUNCTION public.record_analysis_stage(p_run_id uuid, p_worker_id uuid, p_stage text, p_chunk_key text, p_input_hash text, p_attempts integer, p_reused_from uuid, p_output jsonb, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.analysis_runs%ROWTYPE;
  v_count integer;
BEGIN
  v_run := public.assert_analysis_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_output) <> 'object' THEN RAISE EXCEPTION 'Stage output must be a JSON object' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.analysis_stage_results (analysis_run_id, stage, chunk_key, input_hash, model, prompt_version, attempts, reused_from_run_id, output)
  VALUES (p_run_id, p_stage, p_chunk_key, p_input_hash, v_run.model, v_run.prompt_version, greatest(p_attempts, 1), p_reused_from, p_output)
  ON CONFLICT (analysis_run_id, stage, chunk_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.analysis_runs r SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 120)) WHERE r.id = p_run_id;
  RETURN v_count = 1;
END;
$$;

-- Worker: finish its running run with the validated proposals and issues,
-- atomically. Review status is decided here: Inferred → 'Needs Review'.
CREATE OR REPLACE FUNCTION public.complete_analysis_run(p_run_id uuid, p_worker_id uuid, p_model_digest text, p_proposals jsonb, p_issues jsonb, p_diagnostics jsonb, p_with_warnings boolean)
RETURNS TABLE (project_id uuid, document_version_id uuid, status text, proposal_count integer, issue_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.analysis_runs%ROWTYPE;
  v_status text;
  v_p integer;
  v_i integer;
BEGIN
  v_run := public.assert_analysis_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_proposals) <> 'array' OR jsonb_typeof(p_issues) <> 'array' THEN
    RAISE EXCEPTION 'proposals and issues must be arrays' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_proposals x WHERE x.analysis_run_id = p_run_id)
     OR EXISTS (SELECT 1 FROM public.analysis_issues x WHERE x.analysis_run_id = p_run_id) THEN
    RAISE EXCEPTION 'This analysis run already has output' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.requirement_proposals (analysis_run_id, project_id, sequence, proposed_title, proposed_description, proposed_category,
    proposed_priority, source_fragment_ids, primary_source_fragment_id, source_quote, rationale, evidence_basis, confidence, review_status, consolidation)
  SELECT p_run_id, v_run.project_id, (p.ord)::integer, p.v->>'proposed_title', p.v->>'proposed_description', p.v->>'proposed_category',
    p.v->>'proposed_priority', ARRAY(SELECT jsonb_array_elements_text(p.v->'source_fragment_ids'))::uuid[], (p.v->>'primary_source_fragment_id')::uuid,
    p.v->>'source_quote', p.v->>'rationale', p.v->>'evidence_basis', p.v->>'confidence',
    CASE WHEN p.v->>'evidence_basis' = 'Inferred' THEN 'Needs Review' ELSE 'Proposed' END,
    coalesce(p.v->'consolidation', '{}'::jsonb)
  FROM jsonb_array_elements(p_proposals) WITH ORDINALITY AS p(v, ord);
  GET DIAGNOSTICS v_p = ROW_COUNT;

  INSERT INTO public.analysis_issues (analysis_run_id, project_id, sequence, issue_type, severity, description, suggested_question, source_fragment_ids, related_proposal_sequences)
  SELECT p_run_id, v_run.project_id, (i.ord)::integer, i.v->>'issue_type', i.v->>'severity', i.v->>'description', i.v->>'suggested_question',
    ARRAY(SELECT jsonb_array_elements_text(i.v->'source_fragment_ids'))::uuid[],
    coalesce(ARRAY(SELECT jsonb_array_elements_text(i.v->'related_proposal_sequences'))::integer[], '{}')
  FROM jsonb_array_elements(p_issues) WITH ORDINALITY AS i(v, ord);
  GET DIAGNOSTICS v_i = ROW_COUNT;

  v_status := CASE WHEN p_with_warnings THEN 'Completed with warnings' ELSE 'Completed' END;
  UPDATE public.analysis_runs r SET status = v_status, completed_at = now(), lease_expires_at = NULL, model_digest = left(p_model_digest, 100),
    diagnostics = p_diagnostics, proposal_count = v_p, issue_count = v_i,
    warnings_count = coalesce(jsonb_array_length(p_diagnostics->'warnings'), 0)
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; document_version_id := v_run.document_version_id; status := v_status; proposal_count := v_p; issue_count := v_i;
  RETURN NEXT;
END;
$$;

-- Worker: fail its running run with a category and a safe message. Stage
-- results are kept so a retry can resume; no proposals/issues exist.
CREATE OR REPLACE FUNCTION public.fail_analysis_run(p_run_id uuid, p_worker_id uuid, p_category text, p_message text, p_model_digest text, p_diagnostics jsonb)
RETURNS TABLE (project_id uuid, document_version_id uuid)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.analysis_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'Running' OR v_run.worker_id IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'This analysis run is not running for this worker' USING ERRCODE = '55000';
  END IF;
  UPDATE public.analysis_runs r SET status = 'Failed', completed_at = now(), lease_expires_at = NULL,
    error_category = p_category, error_message = left(p_message, 1000), model_digest = left(p_model_digest, 100), diagnostics = p_diagnostics
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; document_version_id := v_run.document_version_id;
  RETURN NEXT;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.queue_analysis_run(uuid, uuid, text, uuid, text, uuid)',
    'public.claim_analysis_run(uuid, text, text, text, text, text, integer)',
    'public.assert_analysis_run_owner(uuid, uuid)',
    'public.record_analysis_stage(uuid, uuid, text, text, text, integer, uuid, jsonb, integer)',
    'public.complete_analysis_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean)',
    'public.fail_analysis_run(uuid, uuid, text, text, text, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.analysis_output_provenance_guard()', 'public.analysis_output_immutable()', 'public.analysis_stage_results_immutable()', 'public.analysis_runs_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_stage_results ENABLE ROW LEVEL SECURITY;  -- no policies: service role only
ALTER TABLE public.requirement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "analysis_runs_select" ON public.analysis_runs FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "requirement_proposals_select" ON public.requirement_proposals FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "analysis_issues_select" ON public.analysis_issues FOR SELECT TO authenticated USING ((SELECT public.can_write()));

REVOKE ALL ON public.analysis_runs, public.analysis_stage_results, public.requirement_proposals, public.analysis_issues FROM anon;
REVOKE ALL ON public.analysis_stage_results FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.analysis_runs, public.requirement_proposals, public.analysis_issues FROM authenticated;
