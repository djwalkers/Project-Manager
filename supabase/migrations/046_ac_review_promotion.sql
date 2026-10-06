-- 046: Human Acceptance Criteria review and promotion (Phase 1F).
--
--   acceptance_criterion_proposals ──review──▶ Approved ──promote──▶ acceptance_criteria (canonical)
--
-- * Canonical acceptance_criteria gains NULLABLE criterion_type and
--   given/when/then text. Existing ACs stay valid with NULLs; nothing is
--   backfilled. ac_ref, requirement_id, project_id, criterion, description
--   and status remain the authoritative canonical fields.
-- * AC proposals gain a human review layer (same model as Phase 1D): the AI
--   originals stay immutable; reviewed_* values, decisions, lineage
--   (origin / parent_proposal_ids, human_authored) and promotion are
--   recorded. The database enforces the transitions:
--     Proposed     → Approved | Needs Review | Rejected | Superseded
--     Needs Review → Approved | Rejected | Superseded
--     Approved     → Promoted | Needs Review | Rejected | Superseded
--     Rejected     → Needs Review (reopen)
--     Promoted, Superseded → final
-- * Approving a Needs Review proposal is gated (ac_approval_blockers): a
--   blocking source question must be Resolved / Not Applicable; a dropped
--   name/condition must be restored in the wording; vague-but-grounded
--   wording needs a recorded Human Clarification; an unsupported
--   interpretation must be corrected (edited) or supported by a Human
--   Clarification; everything else needs an explicit reviewer confirmation.
--   A bare "acknowledge" never bypasses unresolved behaviour.
-- * Human Clarifications (ac_human_clarifications) record reviewer-supplied
--   facts separately from source provenance.
-- * Generation issues become reviewable (Open / Resolved / Accepted /
--   Not Applicable). Change-level scope notes may be associated with
--   promoted Requirements (ac_scope_note_requirements); associated notes
--   are supplied to later generation runs and may be cited by manual
--   proposals. Nothing becomes a Requirement.
-- * Promotion (promote_ac_proposal) is atomic and idempotent: one canonical
--   AC, ac_ref by the app's nextRef rule under a per-project lock, status
--   'Not Started', fixed to the proposal's Requirement; the proposal is
--   Promoted only with the AC it created.
-- * A promoted canonical AC cannot be deleted while a proposal points at it
--   (guard + deferred FK, same idiom as 041); whole-project delete cascades.
-- * Reads: Manager/Admin (can_write). Writes: service role, via the
--   functions below. Completed generation runs and their AI originals are
--   never rewritten.

-- ── Canonical AC extension (additive, nullable) ────────────────────────────

ALTER TABLE public.acceptance_criteria
  ADD COLUMN criterion_type text CHECK (criterion_type IS NULL OR criterion_type IN ('Positive', 'Negative', 'Regression')),
  ADD COLUMN given_text text CHECK (length(given_text) <= 1000),
  ADD COLUMN when_text text CHECK (length(when_text) <= 1000),
  ADD COLUMN then_text text CHECK (length(then_text) <= 1000);

-- ── Proposal review columns ────────────────────────────────────────────────

ALTER TABLE public.acceptance_criterion_proposals
  ADD COLUMN origin text NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'split', 'merge', 'manual')),
  ADD COLUMN parent_proposal_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN human_authored boolean NOT NULL DEFAULT false,
  ADD COLUMN reviewed_criterion text CHECK (length(reviewed_criterion) BETWEEN 1 AND 2000),
  ADD COLUMN reviewed_description text CHECK (length(reviewed_description) <= 4000),
  ADD COLUMN reviewed_criterion_type text CHECK (reviewed_criterion_type IS NULL OR reviewed_criterion_type IN ('Positive', 'Negative', 'Regression')),
  ADD COLUMN reviewed_given_text text CHECK (length(reviewed_given_text) <= 1000),
  ADD COLUMN reviewed_when_text text CHECK (length(reviewed_when_text) <= 1000),
  ADD COLUMN reviewed_then_text text CHECK (length(reviewed_then_text) <= 1000),
  ADD COLUMN review_note text CHECK (length(review_note) <= 2000),
  ADD COLUMN rejection_reason text CHECK (rejection_reason IS NULL OR rejection_reason IN ('Duplicate', 'Incorrect interpretation', 'Too granular', 'Covered by another AC', 'Out of scope', 'Not testable', 'Other')),
  ADD COLUMN review_confirmed_at timestamptz,
  ADD COLUMN review_confirmed_by_name text,
  ADD COLUMN reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by_name text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN promoted_ac_id uuid,
  ADD COLUMN promoted_ac_ref text,
  ADD COLUMN promoted_at timestamptz,
  ADD COLUMN promoted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN promoted_by_name text;
ALTER TABLE public.acceptance_criterion_proposals
  ADD CONSTRAINT acceptance_criterion_proposals_promoted_ac_fkey FOREIGN KEY (promoted_ac_id) REFERENCES public.acceptance_criteria (id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT acceptance_criterion_proposals_ac_means_promoted CHECK (promoted_ac_id IS NULL OR review_status = 'Promoted'),
  ADD CONSTRAINT acceptance_criterion_proposals_promoted_shape CHECK (review_status <> 'Promoted' OR (promoted_ac_id IS NOT NULL AND promoted_ac_ref IS NOT NULL AND promoted_at IS NOT NULL)),
  ADD CONSTRAINT acceptance_criterion_proposals_lineage CHECK (origin IN ('ai', 'manual') OR cardinality(parent_proposal_ids) >= 1);
CREATE UNIQUE INDEX acceptance_criterion_proposals_promoted_ac_key ON public.acceptance_criterion_proposals (promoted_ac_id) WHERE promoted_ac_id IS NOT NULL;

-- ── Generation issue review ────────────────────────────────────────────────

ALTER TABLE public.ac_generation_issues DROP CONSTRAINT ac_generation_issues_status_check;
ALTER TABLE public.ac_generation_issues
  ADD CONSTRAINT ac_generation_issues_status_check CHECK (status IN ('Open', 'Resolved', 'Accepted', 'Not Applicable')),
  ADD COLUMN resolution_note text CHECK (length(resolution_note) <= 2000),
  ADD COLUMN reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by_name text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ── Human Clarifications ───────────────────────────────────────────────────

CREATE TABLE public.ac_human_clarifications (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid        NOT NULL,
  generation_run_id   uuid        NOT NULL,
  proposal_id         uuid        NOT NULL REFERENCES public.acceptance_criterion_proposals(id) ON DELETE CASCADE,
  analysis_issue_id   uuid        REFERENCES public.analysis_issues(id) ON DELETE SET NULL,
  generation_issue_id uuid        REFERENCES public.ac_generation_issues(id) ON DELETE SET NULL,
  clarification       text        NOT NULL CHECK (length(clarification) BETWEEN 1 AND 2000),
  reason              text        CHECK (length(reason) <= 1000),
  created_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name     text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_name     text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ac_human_clarifications_run_fkey FOREIGN KEY (generation_run_id, project_id) REFERENCES public.ac_generation_runs (id, project_id) ON DELETE CASCADE
);
CREATE INDEX ac_human_clarifications_proposal_idx ON public.ac_human_clarifications (proposal_id);

CREATE OR REPLACE FUNCTION public.ac_human_clarifications_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p public.acceptance_criterion_proposals%ROWTYPE;
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.acceptance_criterion_proposals p WHERE p.id = OLD.proposal_id) THEN
      RAISE EXCEPTION 'human clarifications are review history and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO v_p FROM public.acceptance_criterion_proposals p WHERE p.id = NEW.proposal_id;
  IF v_p.generation_run_id IS DISTINCT FROM NEW.generation_run_id OR v_p.project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'a clarification belongs to its proposal''s generation run and project' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.proposal_id <> OLD.proposal_id OR NEW.generation_run_id <> OLD.generation_run_id
     OR NEW.created_by_name <> OLD.created_by_name OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a clarification''s proposal and author are fixed' USING ERRCODE = '22023';
  END IF;
  -- Editable only while the proposal is still under review (a promoted AC relies on it).
  IF v_p.review_status IN ('Promoted', 'Superseded')
     AND NOT (TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'analysis_issue_id' - 'generation_issue_id' - 'created_by') = (to_jsonb(OLD) - 'analysis_issue_id' - 'generation_issue_id' - 'created_by')) THEN
    RAISE EXCEPTION 'a % proposal''s clarifications are final', lower(v_p.review_status) USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = NEW.generation_run_id;
  IF NEW.analysis_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.analysis_issues i WHERE i.id = NEW.analysis_issue_id AND i.analysis_run_id = v_run.analysis_run_id) THEN
    RAISE EXCEPTION 'the related analysis issue must belong to the Requirement''s analysis run' USING ERRCODE = '22023';
  END IF;
  IF NEW.generation_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ac_generation_issues g WHERE g.id = NEW.generation_issue_id AND g.generation_run_id = NEW.generation_run_id) THEN
    RAISE EXCEPTION 'the related generation issue must belong to the same generation run' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ac_human_clarifications_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ac_human_clarifications
  FOR EACH ROW EXECUTE FUNCTION public.ac_human_clarifications_guard();

-- ── Change-level scope notes ↔ promoted Requirements ───────────────────────

CREATE TABLE public.ac_scope_note_requirements (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid        NOT NULL,
  scope_note_id      uuid        NOT NULL REFERENCES public.analysis_scope_notes(id) ON DELETE CASCADE,
  requirement_id     uuid        NOT NULL,
  note               text        CHECK (length(note) <= 1000),
  associated_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  associated_by_name text        NOT NULL,
  associated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ac_scope_note_requirements_requirement_fkey FOREIGN KEY (requirement_id, project_id) REFERENCES public.requirements (id, project_id) ON DELETE CASCADE,
  CONSTRAINT ac_scope_note_requirements_key UNIQUE (scope_note_id, requirement_id)
);

-- ── Guards (replace 043's): AI originals immutable; review transitions ─────

CREATE OR REPLACE FUNCTION public.ac_generation_output_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
  v_cols text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.ac_generation_runs r WHERE r.id = OLD.generation_run_id) THEN
      RAISE EXCEPTION 'generated acceptance criteria are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'acceptance_criterion_proposals' THEN
      v_cols := ARRAY['review_status', 'updated_at', 'reviewed_criterion', 'reviewed_description', 'reviewed_criterion_type', 'reviewed_given_text',
        'reviewed_when_text', 'reviewed_then_text', 'review_note', 'rejection_reason', 'review_confirmed_at', 'review_confirmed_by_name',
        'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'promoted_ac_id', 'promoted_ac_ref', 'promoted_at', 'promoted_by', 'promoted_by_name'];
      IF (to_jsonb(NEW) - v_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_cols) THEN
        RAISE EXCEPTION 'generated acceptance criteria are immutable; only their review fields may change';
      END IF;
      IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NOT (
           (OLD.review_status = 'Proposed' AND NEW.review_status IN ('Approved', 'Needs Review', 'Rejected', 'Superseded'))
        OR (OLD.review_status = 'Needs Review' AND NEW.review_status IN ('Approved', 'Rejected', 'Superseded'))
        OR (OLD.review_status = 'Approved' AND NEW.review_status IN ('Promoted', 'Needs Review', 'Rejected', 'Superseded'))
        OR (OLD.review_status = 'Rejected' AND NEW.review_status = 'Needs Review')) THEN
        RAISE EXCEPTION 'an acceptance criterion proposal cannot move from % to %', OLD.review_status, NEW.review_status;
      END IF;
      IF OLD.promoted_ac_id IS NOT NULL AND NEW.promoted_ac_id IS DISTINCT FROM OLD.promoted_ac_id THEN
        RAISE EXCEPTION 'a promoted proposal keeps the canonical acceptance criterion it created';
      END IF;
      IF OLD.review_status IN ('Promoted', 'Superseded')
         AND (to_jsonb(NEW) - 'updated_at' - 'reviewed_by' - 'promoted_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'reviewed_by' - 'promoted_by') THEN
        RAISE EXCEPTION 'a % acceptance criterion proposal is final', lower(OLD.review_status);
      END IF;
      IF NEW.review_status = 'Promoted' AND OLD.review_status <> 'Promoted' AND NEW.promoted_ac_id IS NULL THEN
        RAISE EXCEPTION 'a proposal becomes Promoted only with the canonical acceptance criterion it created';
      END IF;
    ELSE
      v_cols := ARRAY['status', 'resolution_note', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'updated_at'];
      IF (to_jsonb(NEW) - v_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_cols) THEN
        RAISE EXCEPTION 'generation issues are immutable; only their review fields may change';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = NEW.generation_run_id;
  IF NEW.requirement_id IS DISTINCT FROM v_run.requirement_id THEN
    RAISE EXCEPTION 'output must belong to the run''s Requirement' USING ERRCODE = '22023';
  END IF;
  IF NOT NEW.source_fragment_ids <@ v_run.allowed_fragment_ids THEN
    RAISE EXCEPTION 'every cited source fragment must be one supplied to the generation run' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'acceptance_criterion_proposals' THEN
    -- Scope notes: those supplied to the run, or notes a reviewer has since associated with its Requirement.
    IF NOT NEW.scope_note_ids <@ (v_run.scope_note_ids || ARRAY(SELECT a.scope_note_id FROM public.ac_scope_note_requirements a WHERE a.requirement_id = v_run.requirement_id)) THEN
      RAISE EXCEPTION 'every cited scope note must be one supplied to the generation run or associated with its Requirement' USING ERRCODE = '22023';
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

-- A promoted canonical AC keeps its promotion history (same idiom as 041).
CREATE OR REPLACE FUNCTION public.acceptance_criteria_promoted_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.acceptance_criterion_proposals p WHERE p.promoted_ac_id = OLD.id)
     AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
    RAISE EXCEPTION 'This Acceptance Criterion was created from an approved AI proposal and cannot be deleted because its promotion history must be preserved. Change its status instead.'
      USING ERRCODE = '23503', CONSTRAINT = 'acceptance_criterion_proposals_promoted_ac_fkey';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER acceptance_criteria_promoted_delete_guard BEFORE DELETE ON public.acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION public.acceptance_criteria_promoted_delete_guard();

-- ── Eligibility/input: associated scope notes are supplied too (044 + association) ─

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
  v_quotes text[];
  v_own text;
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
  WITH RECURSIVE lineage(id, sequence, parents) AS (
    SELECT v_p.id, v_p.sequence, v_p.parent_proposal_ids
    UNION
    SELECT p.id, p.sequence, p.parent_proposal_ids FROM public.requirement_proposals p JOIN lineage l ON p.id = ANY (l.parents)
    WHERE p.analysis_run_id = v_p.analysis_run_id
  )
  SELECT array_agg(DISTINCT l.sequence) INTO v_lineage FROM lineage l;
  v_quotes := ARRAY(SELECT DISTINCT q FROM (
    SELECT v_p.source_quote AS q UNION ALL
    SELECT m->>'quote' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_p.consolidation->'members') = 'array' THEN v_p.consolidation->'members' ELSE '[]'::jsonb END) m
  ) x WHERE nullif(btrim(q), '') IS NOT NULL);
  v_own := public.ac_generation_norm(array_to_string(v_quotes || coalesce(v_p.reviewed_description, v_p.proposed_description), ' ¦ '));
  clarification_issue_ids := ARRAY(
    SELECT i.id FROM public.analysis_issues i
    WHERE i.analysis_run_id = v_p.analysis_run_id AND i.issue_type <> 'Out of Scope / Administrative Content'
      AND (i.related_proposal_sequences && v_lineage
        OR (cardinality(i.related_proposal_sequences) = 0 AND length(public.ac_generation_norm(i.trigger_quote)) >= 8
            AND strpos(v_own, public.ac_generation_norm(i.trigger_quote)) > 0))
      AND i.status IN ('Resolved', 'Accepted') AND nullif(btrim(i.resolution_note), '') IS NOT NULL
    ORDER BY i.sequence);
  open_issue_ids := ARRAY(
    SELECT i.id FROM public.analysis_issues i
    WHERE i.analysis_run_id = v_p.analysis_run_id AND i.issue_type <> 'Out of Scope / Administrative Content'
      AND (i.related_proposal_sequences && v_lineage
        OR (cardinality(i.related_proposal_sequences) = 0 AND length(public.ac_generation_norm(i.trigger_quote)) >= 8
            AND strpos(v_own, public.ac_generation_norm(i.trigger_quote)) > 0))
      AND (i.status = 'Open' OR (i.status = 'Accepted' AND nullif(btrim(i.resolution_note), '') IS NULL))
    ORDER BY i.sequence);
  -- Acknowledged scope notes that are part of this Requirement's statement,
  -- or that a reviewer explicitly associated with this Requirement (046).
  scope_note_ids := ARRAY(
    SELECT n.id FROM public.analysis_scope_notes n
    WHERE n.analysis_run_id = v_p.analysis_run_id AND n.acknowledged_at IS NOT NULL
      AND ((n.source_fragment_ids && v_p.source_fragment_ids
            AND length(public.ac_generation_norm(coalesce(n.source_quote, n.description))) >= 8
            AND strpos(v_own, public.ac_generation_norm(coalesce(n.source_quote, n.description))) > 0)
        OR EXISTS (SELECT 1 FROM public.ac_scope_note_requirements a WHERE a.scope_note_id = n.id AND a.requirement_id = v_req.id))
    ORDER BY n.sequence);
  snapshot := jsonb_build_object(
    'requirement', jsonb_build_object('id', v_req.id, 'ref', v_req.requirement_ref, 'title', v_req.title, 'description', v_req.description,
      'category', v_req.category, 'priority', v_req.priority, 'status', v_req.status),
    'proposal', jsonb_build_object('id', v_p.id, 'sequence', v_p.sequence, 'origin', v_p.origin,
      'title', coalesce(v_p.reviewed_title, v_p.proposed_title), 'description', coalesce(v_p.reviewed_description, v_p.proposed_description),
      'original_title', v_p.proposed_title, 'original_description', v_p.proposed_description,
      'edited', (v_p.reviewed_title IS NOT NULL OR v_p.reviewed_description IS NOT NULL),
      'source_quote', v_p.source_quote, 'evidence_basis', v_p.evidence_basis, 'source_quotes', to_jsonb(v_quotes)),
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

-- ── Review functions (service role only; called by /api routes) ───────────

CREATE OR REPLACE FUNCTION public.lock_ac_proposal(p_proposal_id uuid, p_project_id uuid)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.acceptance_criterion_proposals p WHERE p.id = p_proposal_id AND p.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Acceptance criterion proposal not found in this project' USING ERRCODE = 'P0002'; END IF;
  RETURN v;
END;
$$;

-- What still stands between a proposal and approval. Empty = may be approved.
-- p_confirmed: the reviewer explicitly confirmed (required for Needs Review).
CREATE OR REPLACE FUNCTION public.ac_approval_blockers(p_proposal_id uuid, p_confirmed boolean)
RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_out text[] := '{}';
  v_text text;
  v_reason text;
  v_term text;
  v_q uuid;
  v_question text;
  v_clarified boolean;
  v_edited boolean;
BEGIN
  SELECT * INTO v FROM public.acceptance_criterion_proposals p WHERE p.id = p_proposal_id;
  IF NOT FOUND THEN RETURN ARRAY['Proposal not found']; END IF;
  v_text := lower(concat_ws(' ', coalesce(v.reviewed_criterion, v.criterion), coalesce(v.reviewed_given_text, v.given_text),
    coalesce(v.reviewed_when_text, v.when_text), coalesce(v.reviewed_then_text, v.then_text)));
  v_clarified := EXISTS (SELECT 1 FROM public.ac_human_clarifications c WHERE c.proposal_id = v.id);
  v_edited := v.reviewed_criterion IS NOT NULL AND v.reviewed_criterion IS DISTINCT FROM v.criterion;

  -- A: a blocking source question must be Resolved / Not Applicable in the generation-issue review.
  FOREACH v_q IN ARRAY v.open_issue_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ac_generation_issues g WHERE g.generation_run_id = v.generation_run_id AND v_q = ANY (g.analysis_issue_ids)
                     AND g.status IN ('Resolved', 'Not Applicable')) THEN
      SELECT coalesce(i.suggested_question, i.description) INTO v_question FROM public.analysis_issues i WHERE i.id = v_q;
      v_out := v_out || format('Resolve (or set Not Applicable) the blocking question first: %s', left(coalesce(v_question, 'open question'), 300));
    END IF;
  END LOOP;

  FOREACH v_reason IN ARRAY v.needs_review_reasons LOOP
    IF v_reason ~* '^(Blocked by|Depends on) an open question' THEN
      CONTINUE;  -- handled by A
    ELSIF v_reason ~* '^Omits ' THEN
      -- D: every dropped name/condition must be restored in the wording.
      FOR v_term IN SELECT m[1] FROM regexp_matches(v_reason, '"([^"]+)"', 'g') AS m LOOP
        IF strpos(v_text, lower(v_term)) = 0 THEN v_out := v_out || format('Restore "%s" in the criterion — it is named in the source.', v_term); END IF;
      END LOOP;
    ELSIF v_reason ~* '^(Expected result is source-grounded|Vague wording)' THEN
      -- C: vague but grounded — the definition must be recorded as a Human Clarification.
      IF NOT v_clarified THEN v_out := v_out || 'Record a Human Clarification that defines the expected result (the source does not).'::text; END IF;
    ELSIF v_reason ~* '^Expected result introduces an unsupported interpretation' THEN
      -- B: correct the wording, or support it with a Human Clarification.
      IF NOT (v_edited OR v_clarified) THEN v_out := v_out || 'Correct the unsupported wording (edit), or record a Human Clarification that supports it.'::text; END IF;
    END IF;
  END LOOP;

  IF v.review_status = 'Needs Review' AND NOT coalesce(p_confirmed, false) THEN
    v_out := v_out || 'Confirm that you reviewed this criterion against its source.'::text;
  END IF;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_ac_proposal(p_proposal_id uuid, p_project_id uuid, p_criterion text, p_description text, p_type text,
  p_given text, p_when text, p_then text, p_user_id uuid, p_user_name text)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_pick text;
BEGIN
  v := public.lock_ac_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be edited', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  -- A reviewed value equal to the AI original is stored as "not edited".
  UPDATE public.acceptance_criterion_proposals p SET
    reviewed_criterion = CASE WHEN nullif(btrim(p_criterion), '') IS NULL OR btrim(p_criterion) = p.criterion THEN NULL ELSE btrim(p_criterion) END,
    reviewed_description = nullif(btrim(p_description), ''),
    reviewed_criterion_type = CASE WHEN p_type IS NULL OR p_type = p.criterion_type THEN NULL ELSE p_type END,
    reviewed_given_text = CASE WHEN btrim(coalesce(p_given, '')) = coalesce(p.given_text, '') THEN NULL ELSE btrim(p_given) END,
    reviewed_when_text = CASE WHEN btrim(coalesce(p_when, '')) = coalesce(p.when_text, '') THEN NULL ELSE btrim(p_when) END,
    reviewed_then_text = CASE WHEN btrim(coalesce(p_then, '')) = coalesce(p.then_text, '') THEN NULL ELSE btrim(p_then) END,
    review_status = CASE WHEN p.review_status = 'Approved' THEN 'Needs Review' ELSE p.review_status END,
    review_confirmed_at = CASE WHEN p.review_status = 'Approved' THEN NULL ELSE p.review_confirmed_at END,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = v.id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_ac_proposal(p_proposal_id uuid, p_project_id uuid, p_action text, p_note text, p_reason text,
  p_confirm boolean, p_user_id uuid, p_user_name text)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_target text;
  v_blockers text[];
BEGIN
  v := public.lock_ac_proposal(p_proposal_id, p_project_id);
  v_target := CASE p_action WHEN 'approve' THEN 'Approved' WHEN 'reject' THEN 'Rejected' WHEN 'needs_review' THEN 'Needs Review' WHEN 'reopen' THEN 'Needs Review' END;
  IF v_target IS NULL THEN RAISE EXCEPTION 'Unknown review action %', p_action USING ERRCODE = '22023'; END IF;
  IF p_action = 'reopen' AND v.review_status <> 'Rejected' THEN RAISE EXCEPTION 'Only a rejected proposal can be reopened' USING ERRCODE = '55000'; END IF;
  IF v.review_status = v_target THEN RETURN v; END IF;
  IF v_target = 'Approved' THEN
    v_blockers := public.ac_approval_blockers(v.id, p_confirm);
    IF cardinality(v_blockers) > 0 THEN
      RAISE EXCEPTION 'This proposal cannot be approved yet: %', array_to_string(v_blockers, ' ') USING ERRCODE = '55000';
    END IF;
  END IF;
  UPDATE public.acceptance_criterion_proposals p SET review_status = v_target,
    review_note = coalesce(nullif(btrim(p_note), ''), p.review_note),
    rejection_reason = CASE WHEN v_target = 'Rejected' THEN p_reason ELSE NULL END,
    review_confirmed_at = CASE WHEN v_target = 'Approved' AND v.review_status = 'Needs Review' THEN now() WHEN v_target = 'Approved' THEN p.review_confirmed_at ELSE NULL END,
    review_confirmed_by_name = CASE WHEN v_target = 'Approved' AND v.review_status = 'Needs Review' THEN p_user_name WHEN v_target = 'Approved' THEN p.review_confirmed_by_name ELSE NULL END,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = v.id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_ac_proposal_sequence(p_run_id uuid)
RETURNS integer LANGUAGE sql SET search_path = '' AS $$
  SELECT coalesce(max(p.sequence), 0) + 1 FROM public.acceptance_criterion_proposals p WHERE p.generation_run_id = p_run_id
$$;

-- Insert one human-authored (split / merge / manual) proposal. Provenance is
-- checked by ac_generation_output_guard; it always starts Needs Review.
CREATE OR REPLACE FUNCTION public.insert_reviewed_ac_proposal(p_run public.ac_generation_runs, p_child jsonb, p_origin text, p_parents uuid[],
  p_basis text, p_confidence text, p_reasons text[], p_rationale text, p_consolidation jsonb, p_user_id uuid, p_user_name text)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_type text := coalesce(p_child->>'criterion_type', 'Positive');
BEGIN
  IF nullif(btrim(p_child->>'criterion'), '') IS NULL THEN RAISE EXCEPTION 'Every acceptance criterion needs its wording' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.acceptance_criterion_proposals (generation_run_id, project_id, requirement_id, sequence, criterion, given_text, when_text, then_text,
    criterion_type, basis, confidence, review_status, needs_review_reasons, source_fragment_ids, scope_note_ids, clarification_issue_ids, open_issue_ids,
    source_quote, rationale, obligations, consolidation, origin, parent_proposal_ids, human_authored, reviewed_description, reviewed_by, reviewed_by_name, reviewed_at)
  VALUES (p_run.id, p_run.project_id, p_run.requirement_id, public.next_ac_proposal_sequence(p_run.id), btrim(p_child->>'criterion'),
    nullif(btrim(p_child->>'given_text'), ''), nullif(btrim(p_child->>'when_text'), ''), nullif(btrim(p_child->>'then_text'), ''),
    v_type, p_basis, p_confidence, 'Needs Review', p_reasons,
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_child->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_child->'scope_note_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_child->'clarification_issue_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_child->'open_issue_ids', '[]'::jsonb)))::uuid[],
    nullif(btrim(p_child->>'source_quote'), ''), p_rationale, coalesce(p_child->'obligations', '[]'::jsonb), coalesce(p_consolidation, '{}'::jsonb),
    p_origin, coalesce(p_parents, '{}'), true, nullif(btrim(p_child->>'description'), ''), p_user_id, p_user_name, now())
  RETURNING * INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.split_ac_proposal(p_proposal_id uuid, p_project_id uuid, p_children jsonb, p_user_id uuid, p_user_name text)
RETURNS SETOF public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_run public.ac_generation_runs%ROWTYPE;
  v_child jsonb;
  v_new public.acceptance_criterion_proposals%ROWTYPE;
  v_f uuid[]; v_n uuid[]; v_c uuid[]; v_o uuid[];
BEGIN
  v := public.lock_ac_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be split', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_children) <> 'array' OR jsonb_array_length(p_children) < 2 THEN
    RAISE EXCEPTION 'A split needs at least two acceptance criteria' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ac-proposal-seq:' || v.generation_run_id::text));
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = v.generation_run_id;
  FOR v_child IN SELECT * FROM jsonb_array_elements(p_children) LOOP
    v_f := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'source_fragment_ids', '[]'::jsonb)))::uuid[];
    v_n := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'scope_note_ids', '[]'::jsonb)))::uuid[];
    v_c := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'clarification_issue_ids', '[]'::jsonb)))::uuid[];
    v_o := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_child->'open_issue_ids', '[]'::jsonb)))::uuid[];
    -- A child keeps only (a subset of) its parent's provenance, and never none.
    IF NOT (v_f <@ v.source_fragment_ids AND v_n <@ v.scope_note_ids AND v_c <@ v.clarification_issue_ids AND v_o <@ v.open_issue_ids) THEN
      RAISE EXCEPTION 'A split acceptance criterion may only cite provenance of the proposal it was split from' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_f) + cardinality(v_n) + cardinality(v_c) = 0 THEN
      RAISE EXCEPTION 'Every split acceptance criterion needs at least one source reference' USING ERRCODE = '22023';
    END IF;
    v_new := public.insert_reviewed_ac_proposal(v_run, v_child || jsonb_build_object('criterion_type', coalesce(v_child->>'criterion_type', coalesce(v.reviewed_criterion_type, v.criterion_type))),
      'split', ARRAY[v.id], v.basis, v.confidence,
      ARRAY(SELECT r FROM unnest(v.needs_review_reasons) r WHERE r !~* '^(Blocked by|Depends on) an open question' OR cardinality(v_o) > 0)
        || format('Split from #%s by %s — confirm before approval.', v.sequence, p_user_name),
      format('Split from proposal #%s by %s. %s', v.sequence, p_user_name, v.rationale), '{}'::jsonb, p_user_id, p_user_name);
    RETURN NEXT v_new;
  END LOOP;
  UPDATE public.acceptance_criterion_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    review_note = coalesce(p.review_note, format('Split into %s acceptance criteria.', jsonb_array_length(p_children))), updated_at = now()
  WHERE p.id = v.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_ac_proposals(p_proposal_ids uuid[], p_project_id uuid, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_members public.acceptance_criterion_proposals[];
  v_m public.acceptance_criterion_proposals%ROWTYPE;
  v_run public.ac_generation_runs%ROWTYPE;
  v_new public.acceptance_criterion_proposals%ROWTYPE;
  v_id uuid;
BEGIN
  IF cardinality(p_proposal_ids) < 2 THEN RAISE EXCEPTION 'A merge needs at least two proposals' USING ERRCODE = '22023'; END IF;
  FOREACH v_id IN ARRAY p_proposal_ids LOOP
    v_m := public.lock_ac_proposal(v_id, p_project_id);
    IF v_m.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
      RAISE EXCEPTION 'Proposal #% is % and cannot be merged', v_m.sequence, lower(v_m.review_status) USING ERRCODE = '55000';
    END IF;
    v_members := v_members || v_m;
  END LOOP;
  IF (SELECT count(DISTINCT x.generation_run_id) FROM unnest(v_members) x) > 1 THEN
    RAISE EXCEPTION 'Only proposals from the same generation run can be merged' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT coalesce(x.reviewed_criterion_type, x.criterion_type)) FROM unnest(v_members) x) > 1 THEN
    RAISE EXCEPTION 'Only acceptance criteria of the same type (Positive / Negative / Regression) can be merged' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ac-proposal-seq:' || v_members[1].generation_run_id::text));
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = v_members[1].generation_run_id;
  -- Lossless: the union of every member's provenance; every member's wording kept in consolidation.
  v_new := public.insert_reviewed_ac_proposal(v_run,
    p_fields || jsonb_build_object(
      'criterion_type', (SELECT coalesce(x.reviewed_criterion_type, x.criterion_type) FROM unnest(v_members) x LIMIT 1),
      'source_fragment_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.source_fragment_ids) f),
      'scope_note_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.scope_note_ids) f),
      'clarification_issue_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.clarification_issue_ids) f),
      'open_issue_ids', (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM unnest(v_members) x, unnest(x.open_issue_ids) f)),
    'merge', ARRAY(SELECT x.id FROM unnest(v_members) x),
    CASE WHEN EXISTS (SELECT 1 FROM unnest(v_members) x WHERE x.basis = 'Inferred') THEN 'Inferred' ELSE 'Explicit' END,
    (SELECT x.confidence FROM unnest(v_members) x ORDER BY CASE x.confidence WHEN 'Low' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END LIMIT 1),
    ARRAY(SELECT DISTINCT r FROM unnest(v_members) x, unnest(x.needs_review_reasons) r)
      || format('Merged from %s by %s — confirm before approval.', (SELECT string_agg('#' || x.sequence, ', ') FROM unnest(v_members) x), p_user_name),
    format('Merged by %s from proposals %s.', p_user_name, (SELECT string_agg('#' || x.sequence, ', ') FROM unnest(v_members) x)),
    jsonb_build_object('merged', true, 'member_count', cardinality(v_members), 'reason', 'merged by a reviewer',
      'members', (SELECT jsonb_agg(jsonb_build_object('proposal_id', x.id, 'sequence', x.sequence, 'criterion', coalesce(x.reviewed_criterion, x.criterion),
        'given', coalesce(x.reviewed_given_text, x.given_text), 'when', coalesce(x.reviewed_when_text, x.when_text), 'then', coalesce(x.reviewed_then_text, x.then_text),
        'source_ids', to_jsonb(x.source_fragment_ids))) FROM unnest(v_members) x)),
    p_user_id, p_user_name);
  UPDATE public.acceptance_criterion_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    review_note = coalesce(p.review_note, format('Merged into proposal #%s.', v_new.sequence)), updated_at = now()
  WHERE p.id = ANY (p_proposal_ids);
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_manual_ac_proposal(p_run_id uuid, p_project_id uuid, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS public.acceptance_criterion_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = p_run_id AND r.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Generation run not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v_run.status NOT IN ('Completed', 'Completed with warnings') THEN
    RAISE EXCEPTION 'Manual acceptance criteria can be added only to a completed generation run' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(coalesce(p_fields->'source_fragment_ids', '[]'::jsonb)) + jsonb_array_length(coalesce(p_fields->'scope_note_ids', '[]'::jsonb))
     + jsonb_array_length(coalesce(p_fields->'clarification_issue_ids', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Select at least one source reference (fragment, scope note or clarification) for the acceptance criterion' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ac-proposal-seq:' || v_run.id::text));
  RETURN public.insert_reviewed_ac_proposal(v_run, p_fields, 'manual', '{}', 'Inferred', 'Medium',
    ARRAY['Human-authored acceptance criterion — confirm before approval.'],
    coalesce(nullif(btrim(p_fields->>'rationale'), ''), format('Added by %s.', p_user_name)), '{}'::jsonb, p_user_id, p_user_name);
END;
$$;

-- Promote ONE Approved proposal into ONE canonical AC, atomically and idempotently.
CREATE OR REPLACE FUNCTION public.promote_ac_proposal(p_proposal_id uuid, p_project_id uuid, p_ref_prefix text, p_user_id uuid, p_user_name text)
RETURNS TABLE (ac_id uuid, ac_ref text, already_promoted boolean, criterion text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v public.acceptance_criterion_proposals%ROWTYPE;
  v_req public.requirements%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_blockers text[];
  v_clar integer;
  v_text text;
BEGIN
  IF p_ref_prefix !~ '^[A-Z]{2,6}$' THEN RAISE EXCEPTION 'Invalid reference prefix' USING ERRCODE = '22023'; END IF;
  v := public.lock_ac_proposal(p_proposal_id, p_project_id);
  IF v.review_status = 'Promoted' THEN
    ac_id := v.promoted_ac_id; ac_ref := v.promoted_ac_ref; already_promoted := true; criterion := coalesce(v.reviewed_criterion, v.criterion);
    RETURN NEXT; RETURN;
  END IF;
  IF v.review_status <> 'Approved' THEN
    RAISE EXCEPTION 'Only an Approved acceptance criterion proposal can be promoted (this one is %)', v.review_status USING ERRCODE = '55000';
  END IF;
  -- Re-check: a blocking question re-opened after approval stops promotion.
  v_blockers := public.ac_approval_blockers(v.id, true);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'This proposal cannot be promoted: %', array_to_string(v_blockers, ' ') USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_req FROM public.requirements q WHERE q.id = v.requirement_id AND q.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The Requirement no longer exists in this project' USING ERRCODE = 'P0002'; END IF;
  IF lower(btrim(coalesce(v_req.status, ''))) IN ('approved', 'complete', 'closed') THEN
    RAISE EXCEPTION 'Requirement % is % (signed off); acceptance criteria are not added to a signed-off Requirement', v_req.requirement_ref, v_req.status USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_clar FROM public.ac_human_clarifications c WHERE c.proposal_id = v.id;
  -- One reference allocation at a time per project (nextRef: max PREFIX-n + 1, zero-padded to 3).
  PERFORM pg_advisory_xact_lock(hashtext('ac-ref:' || p_project_id::text));
  SELECT p_ref_prefix || '-' || lpad((coalesce(max((substring(a.ac_ref FROM '(?i)^' || p_ref_prefix || '-(\d+)$'))::integer), 0) + 1)::text, 3, '0')
    INTO v_ref FROM public.acceptance_criteria a WHERE a.project_id = p_project_id;
  v_text := coalesce(v.reviewed_criterion, v.criterion);
  INSERT INTO public.acceptance_criteria (project_id, requirement_id, ac_ref, criterion, description, status, notes,
    criterion_type, given_text, when_text, then_text)
  VALUES (p_project_id, v.requirement_id, v_ref, v_text, v.reviewed_description, 'Not Started',
    left(format('Promoted from AI acceptance criteria proposal #%s for %s by %s.%s', v.sequence, v_req.requirement_ref, p_user_name,
      CASE WHEN v_clar > 0 THEN format(' Relies on %s Human Clarification%s.', v_clar, CASE WHEN v_clar = 1 THEN '' ELSE 's' END) ELSE '' END), 2000),
    coalesce(v.reviewed_criterion_type, v.criterion_type), coalesce(v.reviewed_given_text, v.given_text),
    coalesce(v.reviewed_when_text, v.when_text), coalesce(v.reviewed_then_text, v.then_text))
  RETURNING id INTO v_id;
  UPDATE public.acceptance_criterion_proposals p SET review_status = 'Promoted', promoted_ac_id = v_id, promoted_ac_ref = v_ref,
    promoted_at = now(), promoted_by = p_user_id, promoted_by_name = p_user_name, updated_at = now()
  WHERE p.id = v.id;
  ac_id := v_id; ac_ref := v_ref; already_promoted := false; criterion := v_text;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_ac_generation_issue(p_issue_id uuid, p_project_id uuid, p_status text, p_note text, p_user_id uuid, p_user_name text)
RETURNS public.ac_generation_issues
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.ac_generation_issues%ROWTYPE;
BEGIN
  IF p_status NOT IN ('Open', 'Resolved', 'Accepted', 'Not Applicable') THEN RAISE EXCEPTION 'Unknown issue status %', p_status USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM public.ac_generation_issues i WHERE i.id = p_issue_id AND i.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Generation issue not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF p_status IN ('Resolved', 'Not Applicable') AND nullif(btrim(coalesce(p_note, v.resolution_note)), '') IS NULL THEN
    RAISE EXCEPTION 'Record how the issue was resolved (or why it does not apply)' USING ERRCODE = '22023';
  END IF;
  UPDATE public.ac_generation_issues i SET status = p_status, resolution_note = coalesce(nullif(btrim(p_note), ''), i.resolution_note),
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE i.id = v.id RETURNING i.* INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_ac_clarification(p_clarification_id uuid, p_proposal_id uuid, p_project_id uuid, p_text text, p_reason text,
  p_analysis_issue_id uuid, p_generation_issue_id uuid, p_user_id uuid, p_user_name text)
RETURNS public.ac_human_clarifications
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_p public.acceptance_criterion_proposals%ROWTYPE;
  v public.ac_human_clarifications%ROWTYPE;
BEGIN
  v_p := public.lock_ac_proposal(p_proposal_id, p_project_id);
  IF p_clarification_id IS NULL THEN
    INSERT INTO public.ac_human_clarifications (project_id, generation_run_id, proposal_id, analysis_issue_id, generation_issue_id, clarification, reason, created_by, created_by_name)
    VALUES (p_project_id, v_p.generation_run_id, v_p.id, p_analysis_issue_id, p_generation_issue_id, btrim(p_text), nullif(btrim(p_reason), ''), p_user_id, p_user_name)
    RETURNING * INTO v;
  ELSE
    UPDATE public.ac_human_clarifications c SET clarification = btrim(p_text), reason = nullif(btrim(p_reason), ''),
      analysis_issue_id = p_analysis_issue_id, generation_issue_id = p_generation_issue_id, updated_by_name = p_user_name, updated_at = now()
    WHERE c.id = p_clarification_id AND c.proposal_id = v_p.id RETURNING * INTO v;
    IF NOT FOUND THEN RAISE EXCEPTION 'Clarification not found for this proposal' USING ERRCODE = 'P0002'; END IF;
  END IF;
  -- A clarification changes what the criterion relies on: an Approved proposal returns to Needs Review.
  IF v_p.review_status = 'Approved' THEN
    UPDATE public.acceptance_criterion_proposals p SET review_status = 'Needs Review', review_confirmed_at = NULL, review_confirmed_by_name = NULL,
      reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now() WHERE p.id = v_p.id;
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_scope_note_association(p_note_id uuid, p_requirement_id uuid, p_project_id uuid, p_associate boolean, p_note text, p_user_id uuid, p_user_name text)
RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_n public.analysis_scope_notes%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO v_n FROM public.analysis_scope_notes n WHERE n.id = p_note_id AND n.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Scope note not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF p_associate THEN
    IF v_n.acknowledged_at IS NULL THEN RAISE EXCEPTION 'Acknowledge the scope note in the analysis review before associating it' USING ERRCODE = '55000'; END IF;
    -- Only with a Requirement promoted from the same analysis run (same source document).
    IF NOT EXISTS (SELECT 1 FROM public.requirement_proposals p WHERE p.promoted_record_id = p_requirement_id AND p.project_id = p_project_id
                     AND p.review_status = 'Promoted' AND p.analysis_run_id = v_n.analysis_run_id) THEN
      RAISE EXCEPTION 'A scope note can be associated only with a Requirement promoted from the same analysis' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.ac_scope_note_requirements (project_id, scope_note_id, requirement_id, note, associated_by, associated_by_name)
    VALUES (p_project_id, p_note_id, p_requirement_id, nullif(btrim(p_note), ''), p_user_id, p_user_name)
    ON CONFLICT (scope_note_id, requirement_id) DO NOTHING;
  ELSE
    DELETE FROM public.ac_scope_note_requirements a WHERE a.scope_note_id = p_note_id AND a.requirement_id = p_requirement_id AND a.project_id = p_project_id;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Adopting a newer run: its Requirement's older runs' UNPROMOTED open proposals → Superseded.
CREATE OR REPLACE FUNCTION public.supersede_older_ac_proposals(p_run_id uuid, p_project_id uuid, p_user_id uuid, p_user_name text)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_run public.ac_generation_runs%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO v_run FROM public.ac_generation_runs r WHERE r.id = p_run_id AND r.project_id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Generation run not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v_run.status NOT IN ('Completed', 'Completed with warnings') THEN RAISE EXCEPTION 'Only a completed run can be adopted' USING ERRCODE = '55000'; END IF;
  UPDATE public.acceptance_criterion_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    review_note = coalesce(p.review_note, 'Superseded by a newer generation run that the reviewer adopted.'), updated_at = now()
  FROM public.ac_generation_runs r
  WHERE p.generation_run_id = r.id AND r.requirement_id = v_run.requirement_id AND r.id <> v_run.id AND r.queued_at < v_run.queued_at
    AND p.review_status IN ('Proposed', 'Needs Review', 'Approved');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.ac_generation_input(uuid, uuid)',
    'public.lock_ac_proposal(uuid, uuid)',
    'public.ac_approval_blockers(uuid, boolean)',
    'public.edit_ac_proposal(uuid, uuid, text, text, text, text, text, text, uuid, text)',
    'public.review_ac_proposal(uuid, uuid, text, text, text, boolean, uuid, text)',
    'public.next_ac_proposal_sequence(uuid)',
    'public.insert_reviewed_ac_proposal(public.ac_generation_runs, jsonb, text, uuid[], text, text, text[], text, jsonb, uuid, text)',
    'public.split_ac_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.merge_ac_proposals(uuid[], uuid, jsonb, uuid, text)',
    'public.create_manual_ac_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.promote_ac_proposal(uuid, uuid, text, uuid, text)',
    'public.review_ac_generation_issue(uuid, uuid, text, text, uuid, text)',
    'public.save_ac_clarification(uuid, uuid, uuid, text, text, uuid, uuid, uuid, text)',
    'public.set_scope_note_association(uuid, uuid, uuid, boolean, text, uuid, text)',
    'public.supersede_older_ac_proposals(uuid, uuid, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.ac_generation_output_guard()', 'public.ac_human_clarifications_guard()', 'public.acceptance_criteria_promoted_delete_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.ac_human_clarifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_scope_note_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ac_human_clarifications_select" ON public.ac_human_clarifications FOR SELECT TO authenticated USING ((SELECT public.can_write()));
CREATE POLICY "ac_scope_note_requirements_select" ON public.ac_scope_note_requirements FOR SELECT TO authenticated USING ((SELECT public.can_write()));
REVOKE ALL ON public.ac_human_clarifications, public.ac_scope_note_requirements FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ac_human_clarifications, public.ac_scope_note_requirements FROM authenticated;
