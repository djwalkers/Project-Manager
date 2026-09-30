-- 040: Human review and promotion of AI requirement analysis (Phase 1D).
--
--   requirement_proposals ──review──▶ Approved ──promote──▶ requirements (canonical)
--   analysis_issues       ──review──▶ Resolved / Accepted / Not Applicable
--                         ──promote─▶ discovery_questions | actions | risks | decisions
--   analysis_scope_notes  ──acknowledge (never promoted)
--
-- * The AI's original output stays immutable: proposed_* / source / rationale
--   / evidence / confidence / consolidation never change. A reviewer's edits
--   go into reviewed_* columns (the effective value is reviewed_* when set,
--   otherwise proposed_*), and every edit is written to the canonical
--   audit_log with its old and new value (the edit history).
-- * Review state machine (enforced by trigger):
--     Proposed     → Approved | Rejected | Needs Review | Superseded
--     Needs Review → Approved | Rejected | Superseded
--     Approved     → Promoted | Needs Review | Rejected | Superseded
--     Rejected     → Needs Review (reopen)
--     Promoted, Superseded → final
--   Promoted only together with the canonical record it created. An Inferred
--   proposal cannot be Approved or Promoted without a recorded human
--   acknowledgement of the interpretation.
-- * Split / merge create HUMAN-DERIVED proposals (origin 'split' / 'merge')
--   in the same analysis run, with parent lineage; their fragments must be
--   drawn from their parents' fragments (never empty) and still belong to the
--   run's extraction job (038 provenance trigger). Parents become Superseded.
-- * Promotion runs in ONE transaction under a per-project advisory lock:
--   the canonical Requirement is created with the next reference (the app's
--   nextRef semantics: highest PREFIX-n + 1, three digits), status
--   'Discovery', no owner, and the proposal becomes Promoted with the new
--   record's id. promoted_record_id is UNIQUE; a repeated / concurrent call
--   returns the existing record instead of creating another. Any failure
--   rolls the whole promotion back, so the proposal is never Promoted
--   without its Requirement.
-- * Issue promotion follows the same pattern into the existing governance
--   tables (one target record per issue, UNIQUE).
-- * Reads stay Manager/Admin (038/039 RLS); writes are service-role only via
--   the functions below. Nothing here touches ProjectState, Go-Live
--   Readiness, tests or reporting logic; existing canonical rows are never
--   modified.

-- ── Proposals: review columns, lineage, promotion ────────────────────────────

ALTER TABLE public.requirement_proposals
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'split', 'merge')),
  ADD COLUMN IF NOT EXISTS parent_proposal_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_title text CHECK (length(reviewed_title) BETWEEN 1 AND 300),
  ADD COLUMN IF NOT EXISTS reviewed_description text CHECK (length(reviewed_description) BETWEEN 1 AND 4000),
  ADD COLUMN IF NOT EXISTS reviewed_category text CHECK (reviewed_category IN ('Business Rule', 'Database', 'Backend', 'UI', 'Performance', 'Testing')),
  ADD COLUMN IF NOT EXISTS reviewed_priority text CHECK (reviewed_priority IN ('Low', 'Medium', 'High', 'Critical')),
  ADD COLUMN IF NOT EXISTS review_note text CHECK (length(review_note) <= 2000),
  ADD COLUMN IF NOT EXISTS rejection_reason text CHECK (rejection_reason IN ('Duplicate', 'Out of scope', 'Incorrect interpretation', 'Too granular', 'Covered elsewhere', 'Other')),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by_name text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS inferred_acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inferred_acknowledged_by_name text,
  ADD COLUMN IF NOT EXISTS inferred_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_record_id uuid REFERENCES public.requirements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promoted_ref text,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promoted_by_name text;

CREATE UNIQUE INDEX IF NOT EXISTS requirement_proposals_promoted_record_key ON public.requirement_proposals (promoted_record_id) WHERE promoted_record_id IS NOT NULL;

ALTER TABLE public.requirement_proposals
  ADD CONSTRAINT requirement_proposals_derived_has_parents CHECK (origin = 'ai' OR cardinality(parent_proposal_ids) >= 1),
  ADD CONSTRAINT requirement_proposals_promoted_shape CHECK (review_status <> 'Promoted' OR (promoted_at IS NOT NULL AND promoted_ref IS NOT NULL)),
  ADD CONSTRAINT requirement_proposals_record_means_promoted CHECK (promoted_record_id IS NULL OR review_status = 'Promoted'),
  ADD CONSTRAINT requirement_proposals_inferred_acknowledged CHECK (
    evidence_basis <> 'Inferred' OR review_status NOT IN ('Approved', 'Promoted') OR inferred_acknowledged_at IS NOT NULL);

-- ── Issues: review and promotion ─────────────────────────────────────────────

ALTER TABLE public.analysis_issues
  ADD COLUMN IF NOT EXISTS resolution_note text CHECK (length(resolution_note) <= 2000),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by_name text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_target_type text CHECK (promoted_target_type IN ('discovery_questions', 'actions', 'risks', 'decisions')),
  ADD COLUMN IF NOT EXISTS promoted_record_id uuid,
  ADD COLUMN IF NOT EXISTS promoted_ref text,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_by_name text;
CREATE UNIQUE INDEX IF NOT EXISTS analysis_issues_promoted_record_key ON public.analysis_issues (promoted_record_id) WHERE promoted_record_id IS NOT NULL;
ALTER TABLE public.analysis_issues
  ADD CONSTRAINT analysis_issues_promotion_shape CHECK ((promoted_record_id IS NULL) = (promoted_target_type IS NULL));

-- ── Scope notes: acknowledgement only ────────────────────────────────────────

ALTER TABLE public.analysis_scope_notes
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_by_name text,
  ADD COLUMN IF NOT EXISTS acknowledgement_note text CHECK (length(acknowledgement_note) <= 2000);

-- ── Guards: AI output immutable; only review columns and allowed transitions ─

CREATE OR REPLACE FUNCTION public.analysis_output_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_review_cols text[];
BEGIN
  IF TG_TABLE_NAME = 'requirement_proposals' THEN
    v_review_cols := ARRAY['review_status', 'updated_at', 'reviewed_title', 'reviewed_description', 'reviewed_category', 'reviewed_priority',
      'review_note', 'rejection_reason', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'inferred_acknowledged_by',
      'inferred_acknowledged_by_name', 'inferred_acknowledged_at', 'promoted_record_id', 'promoted_ref', 'promoted_at', 'promoted_by', 'promoted_by_name'];
    IF (to_jsonb(NEW) - v_review_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_review_cols) THEN
      RAISE EXCEPTION 'generated proposal content is immutable; only its review fields may change';
    END IF;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NOT (
         (OLD.review_status = 'Proposed' AND NEW.review_status IN ('Approved', 'Rejected', 'Needs Review', 'Superseded'))
      OR (OLD.review_status = 'Needs Review' AND NEW.review_status IN ('Approved', 'Rejected', 'Superseded'))
      OR (OLD.review_status = 'Approved' AND NEW.review_status IN ('Promoted', 'Needs Review', 'Rejected', 'Superseded'))
      OR (OLD.review_status = 'Rejected' AND NEW.review_status = 'Needs Review')) THEN
      RAISE EXCEPTION 'a proposal cannot move from % to %', OLD.review_status, NEW.review_status;
    END IF;
    IF OLD.review_status IN ('Promoted', 'Superseded') AND to_jsonb(NEW) - 'updated_at' - 'promoted_record_id' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' - 'promoted_record_id' THEN
      RAISE EXCEPTION 'a % proposal is final', lower(OLD.review_status);
    END IF;
    IF NEW.review_status = 'Promoted' AND OLD.review_status <> 'Promoted' AND NEW.promoted_record_id IS NULL THEN
      RAISE EXCEPTION 'a proposal becomes Promoted only with the canonical record it created';
    END IF;
  ELSIF TG_TABLE_NAME = 'analysis_issues' THEN
    v_review_cols := ARRAY['status', 'updated_at', 'resolution_note', 'reviewed_by', 'reviewed_by_name', 'reviewed_at',
      'promoted_target_type', 'promoted_record_id', 'promoted_ref', 'promoted_at', 'promoted_by_name'];
    IF (to_jsonb(NEW) - v_review_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_review_cols) THEN
      RAISE EXCEPTION 'generated issue content is immutable; only its review fields may change';
    END IF;
    IF OLD.promoted_record_id IS NOT NULL AND NEW.promoted_record_id IS DISTINCT FROM OLD.promoted_record_id THEN
      RAISE EXCEPTION 'an issue is promoted once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_scope_notes_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ack text[] := ARRAY['acknowledged_at', 'acknowledged_by', 'acknowledged_by_name', 'acknowledgement_note'];
BEGIN
  IF (to_jsonb(NEW) - v_ack) IS DISTINCT FROM (to_jsonb(OLD) - v_ack) THEN
    RAISE EXCEPTION 'scope notes record what the analysis found and cannot be changed; they can only be acknowledged';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Work functions (service role only; called by Manager/Admin routes) ──────

CREATE OR REPLACE FUNCTION public.lock_proposal(p_proposal_id uuid, p_project_id uuid)
RETURNS public.requirement_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.requirement_proposals%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.requirement_proposals p WHERE p.id = p_proposal_id AND p.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proposal not found in this project' USING ERRCODE = 'P0002'; END IF;
  RETURN v;
END;
$$;

-- Edit the reviewed version (the AI original is untouched). Editing an
-- Approved proposal returns it to Needs Review: approval covers exact text.
CREATE OR REPLACE FUNCTION public.edit_requirement_proposal(p_proposal_id uuid, p_project_id uuid, p_title text, p_description text, p_category text, p_priority text, p_user_id uuid, p_user_name text)
RETURNS public.requirement_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.requirement_proposals%ROWTYPE;
BEGIN
  v := public.lock_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be edited', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  UPDATE public.requirement_proposals p SET
    reviewed_title = CASE WHEN p_title IS NULL OR p_title = v.proposed_title THEN NULL ELSE p_title END,
    reviewed_description = CASE WHEN p_description IS NULL OR p_description = v.proposed_description THEN NULL ELSE p_description END,
    reviewed_category = CASE WHEN p_category IS NULL OR p_category = v.proposed_category THEN NULL ELSE p_category END,
    reviewed_priority = CASE WHEN p_priority IS NULL OR p_priority = v.proposed_priority THEN NULL ELSE p_priority END,
    review_status = CASE WHEN v.review_status = 'Approved' THEN 'Needs Review' ELSE v.review_status END,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = p_proposal_id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

-- Approve / reject / needs review / reopen. Approving an Inferred proposal
-- requires p_acknowledge_inferred (recorded with who and when).
CREATE OR REPLACE FUNCTION public.review_requirement_proposal(p_proposal_id uuid, p_project_id uuid, p_action text, p_note text, p_reason text, p_acknowledge_inferred boolean, p_user_id uuid, p_user_name text)
RETURNS public.requirement_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.requirement_proposals%ROWTYPE;
  v_target text;
BEGIN
  v := public.lock_proposal(p_proposal_id, p_project_id);
  v_target := CASE p_action WHEN 'approve' THEN 'Approved' WHEN 'reject' THEN 'Rejected' WHEN 'needs_review' THEN 'Needs Review' WHEN 'reopen' THEN 'Needs Review' END;
  IF v_target IS NULL THEN RAISE EXCEPTION 'Unknown review action %', p_action USING ERRCODE = '22023'; END IF;
  IF p_action = 'reopen' AND v.review_status <> 'Rejected' THEN RAISE EXCEPTION 'Only a rejected proposal can be reopened' USING ERRCODE = '55000'; END IF;
  IF v.review_status = v_target THEN RETURN v; END IF; -- repeat of the same decision: no-op
  IF v_target = 'Approved' AND v.evidence_basis = 'Inferred' AND v.inferred_acknowledged_at IS NULL AND NOT coalesce(p_acknowledge_inferred, false) THEN
    RAISE EXCEPTION 'This proposal is Inferred: confirm the interpretation is intended before approving it' USING ERRCODE = '55000';
  END IF;
  UPDATE public.requirement_proposals p SET
    review_status = v_target,
    review_note = coalesce(nullif(btrim(p_note), ''), p.review_note),
    rejection_reason = CASE WHEN v_target = 'Rejected' THEN p_reason ELSE NULL END,
    inferred_acknowledged_by = CASE WHEN v_target = 'Approved' AND p.evidence_basis = 'Inferred' AND p.inferred_acknowledged_at IS NULL THEN p_user_id ELSE p.inferred_acknowledged_by END,
    inferred_acknowledged_by_name = CASE WHEN v_target = 'Approved' AND p.evidence_basis = 'Inferred' AND p.inferred_acknowledged_at IS NULL THEN p_user_name ELSE p.inferred_acknowledged_by_name END,
    inferred_acknowledged_at = CASE WHEN v_target = 'Approved' AND p.evidence_basis = 'Inferred' AND p.inferred_acknowledged_at IS NULL THEN now() ELSE p.inferred_acknowledged_at END,
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE p.id = p_proposal_id RETURNING p.* INTO v;
  RETURN v;
END;
$$;

-- Next canonical sequence number of a proposal run.
CREATE OR REPLACE FUNCTION public.next_proposal_sequence(p_run_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(max(p.sequence), 0) + 1 FROM public.requirement_proposals p WHERE p.analysis_run_id = p_run_id;
$$;

-- Split one proposal into 2+ human-derived children (same run), each citing
-- a non-empty subset of the parent's fragments. The parent is Superseded.
CREATE OR REPLACE FUNCTION public.split_requirement_proposal(p_proposal_id uuid, p_project_id uuid, p_children jsonb, p_user_id uuid, p_user_name text)
RETURNS SETOF public.requirement_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.requirement_proposals%ROWTYPE;
  c jsonb;
  v_ids uuid[];
  v_seq integer;
BEGIN
  v := public.lock_proposal(p_proposal_id, p_project_id);
  IF v.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
    RAISE EXCEPTION 'A % proposal cannot be split', lower(v.review_status) USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_children) <> 'array' OR jsonb_array_length(p_children) < 2 OR jsonb_array_length(p_children) > 20 THEN
    RAISE EXCEPTION 'A split needs 2–20 child proposals' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('proposal-seq:' || v.analysis_run_id::text));
  v_seq := public.next_proposal_sequence(v.analysis_run_id);
  FOR c IN SELECT * FROM jsonb_array_elements(p_children) LOOP
    v_ids := ARRAY(SELECT DISTINCT jsonb_array_elements_text(c->'source_fragment_ids'))::uuid[];
    IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'Every child proposal needs at least one source fragment' USING ERRCODE = '22023'; END IF;
    IF NOT v_ids <@ v.source_fragment_ids THEN RAISE EXCEPTION 'A child proposal may only cite fragments of the proposal it was split from' USING ERRCODE = '22023'; END IF;
    RETURN QUERY INSERT INTO public.requirement_proposals (analysis_run_id, project_id, sequence, proposed_title, proposed_description, proposed_category,
      proposed_priority, source_fragment_ids, primary_source_fragment_id, source_quote, rationale, evidence_basis, confidence, review_status,
      consolidation, origin, parent_proposal_ids, reviewed_by, reviewed_by_name, reviewed_at)
    VALUES (v.analysis_run_id, v.project_id, v_seq, c->>'title', c->>'description',
      coalesce(c->>'category', v.reviewed_category, v.proposed_category), coalesce(c->>'priority', v.reviewed_priority, v.proposed_priority),
      v_ids, CASE WHEN v.primary_source_fragment_id = ANY (v_ids) THEN v.primary_source_fragment_id ELSE v_ids[1] END,
      v.source_quote, format('Split by %s from proposal #%s (%s).', p_user_name, v.sequence, coalesce(v.reviewed_title, v.proposed_title)),
      v.evidence_basis, v.confidence, 'Needs Review',
      jsonb_build_object('split_from', jsonb_build_object('proposal_id', v.id, 'sequence', v.sequence, 'title', coalesce(v.reviewed_title, v.proposed_title))),
      'split', ARRAY[v.id], p_user_id, p_user_name, now())
    RETURNING *;
    v_seq := v_seq + 1;
  END LOOP;
  UPDATE public.requirement_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    review_note = coalesce(p.review_note, format('Split into %s proposals.', jsonb_array_length(p_children))), updated_at = now()
  WHERE p.id = v.id;
END;
$$;

-- Merge 2+ proposals of the same run into one human-derived proposal citing
-- every fragment of every member (lossless provenance). Members are Superseded.
CREATE OR REPLACE FUNCTION public.merge_requirement_proposals(p_proposal_ids uuid[], p_project_id uuid, p_title text, p_description text, p_category text, p_priority text, p_user_id uuid, p_user_name text)
RETURNS public.requirement_proposals
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_members public.requirement_proposals[];
  v_run uuid;
  v_ids uuid[];
  v_new public.requirement_proposals%ROWTYPE;
  m public.requirement_proposals%ROWTYPE;
BEGIN
  IF cardinality(p_proposal_ids) < 2 THEN RAISE EXCEPTION 'Select at least two proposals to merge' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(p ORDER BY p.sequence) INTO v_members FROM (
    SELECT * FROM public.requirement_proposals p WHERE p.id = ANY (p_proposal_ids) AND p.project_id = p_project_id ORDER BY p.id FOR UPDATE) p;
  IF coalesce(cardinality(v_members), 0) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_proposal_ids))) THEN
    RAISE EXCEPTION 'Proposal not found in this project' USING ERRCODE = 'P0002';
  END IF;
  FOREACH m IN ARRAY v_members LOOP
    IF v_run IS NULL THEN v_run := m.analysis_run_id; ELSIF v_run <> m.analysis_run_id THEN
      RAISE EXCEPTION 'Only proposals from the same analysis run can be merged' USING ERRCODE = '22023';
    END IF;
    IF m.review_status NOT IN ('Proposed', 'Needs Review', 'Approved') THEN
      RAISE EXCEPTION 'Proposal #% is % and cannot be merged', m.sequence, lower(m.review_status) USING ERRCODE = '55000';
    END IF;
  END LOOP;
  v_ids := ARRAY(SELECT DISTINCT unnest(ARRAY(SELECT unnest(x.source_fragment_ids) FROM unnest(v_members) x)));
  PERFORM pg_advisory_xact_lock(hashtext('proposal-seq:' || v_run::text));
  INSERT INTO public.requirement_proposals (analysis_run_id, project_id, sequence, proposed_title, proposed_description, proposed_category,
    proposed_priority, source_fragment_ids, primary_source_fragment_id, source_quote, rationale, evidence_basis, confidence, review_status,
    consolidation, origin, parent_proposal_ids, reviewed_by, reviewed_by_name, reviewed_at)
  VALUES (v_run, p_project_id, public.next_proposal_sequence(v_run), p_title, p_description, p_category, p_priority, v_ids,
    v_members[1].primary_source_fragment_id,
    left(array_to_string(ARRAY(SELECT x.source_quote FROM unnest(v_members) x WHERE x.source_quote IS NOT NULL), ' … '), 2000),
    format('Merged by %s from proposals %s.', p_user_name, array_to_string(ARRAY(SELECT '#' || x.sequence FROM unnest(v_members) x), ', ')),
    CASE WHEN EXISTS (SELECT 1 FROM unnest(v_members) x WHERE x.evidence_basis = 'Inferred') THEN 'Inferred' ELSE 'Explicit' END,
    (SELECT x.confidence FROM unnest(v_members) x ORDER BY CASE x.confidence WHEN 'Low' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END LIMIT 1),
    'Needs Review',
    jsonb_build_object('merged_from', (SELECT jsonb_agg(jsonb_build_object('proposal_id', x.id, 'sequence', x.sequence,
      'title', coalesce(x.reviewed_title, x.proposed_title), 'description', coalesce(x.reviewed_description, x.proposed_description),
      'source_fragment_ids', to_jsonb(x.source_fragment_ids))) FROM unnest(v_members) x)),
    'merge', ARRAY(SELECT x.id FROM unnest(v_members) x), p_user_id, p_user_name, now())
  RETURNING * INTO v_new;
  UPDATE public.requirement_proposals p SET review_status = 'Superseded', reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(),
    review_note = coalesce(p.review_note, format('Merged into proposal #%s.', v_new.sequence)), updated_at = now()
  WHERE p.id = ANY (p_proposal_ids);
  RETURN v_new;
END;
$$;

-- Promote an Approved proposal into ONE canonical Requirement, atomically
-- and idempotently. Reference: the app's nextRef semantics for the prefix
-- the server passes from the module configuration.
CREATE OR REPLACE FUNCTION public.promote_requirement_proposal(p_proposal_id uuid, p_project_id uuid, p_ref_prefix text, p_source text, p_notes text, p_user_id uuid, p_user_name text)
RETURNS TABLE (requirement_id uuid, requirement_ref text, already_promoted boolean, title text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v public.requirement_proposals%ROWTYPE;
  v_ref text;
  v_title text;
  v_category text;
  v_priority text;
  v_id uuid;
BEGIN
  IF p_ref_prefix !~ '^[A-Z]{2,6}$' THEN RAISE EXCEPTION 'Invalid reference prefix' USING ERRCODE = '22023'; END IF;
  v := public.lock_proposal(p_proposal_id, p_project_id);
  IF v.review_status = 'Promoted' THEN
    requirement_id := v.promoted_record_id; requirement_ref := v.promoted_ref; already_promoted := true; title := coalesce(v.reviewed_title, v.proposed_title);
    RETURN NEXT; RETURN;
  END IF;
  IF v.review_status <> 'Approved' THEN
    RAISE EXCEPTION 'Only an Approved proposal can be promoted (this one is %)', v.review_status USING ERRCODE = '55000';
  END IF;
  IF v.evidence_basis = 'Inferred' AND v.inferred_acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'An Inferred proposal needs an acknowledged interpretation before promotion' USING ERRCODE = '55000';
  END IF;
  v_title := coalesce(v.reviewed_title, v.proposed_title);
  v_category := coalesce(v.reviewed_category, v.proposed_category);
  v_priority := coalesce(v.reviewed_priority, v.proposed_priority);
  IF v_category IS NULL OR v_priority IS NULL THEN
    RAISE EXCEPTION 'Set the category and priority in the review before promoting — they are not chosen automatically' USING ERRCODE = '22023';
  END IF;

  -- One reference allocation at a time per project (nextRef: max PREFIX-n + 1, zero-padded to 3).
  PERFORM pg_advisory_xact_lock(hashtext('requirement-ref:' || p_project_id::text));
  SELECT p_ref_prefix || '-' || lpad((coalesce(max((substring(r.requirement_ref FROM '(?i)^' || p_ref_prefix || '-(\d+)$'))::integer), 0) + 1)::text, 3, '0')
    INTO v_ref FROM public.requirements r WHERE r.project_id = p_project_id;

  INSERT INTO public.requirements (project_id, requirement_ref, title, description, priority, category, status, owner, source, notes)
  VALUES (p_project_id, v_ref, v_title, coalesce(v.reviewed_description, v.proposed_description), v_priority, v_category, 'Discovery', NULL, p_source, p_notes)
  RETURNING id INTO v_id;

  UPDATE public.requirement_proposals p SET review_status = 'Promoted', promoted_record_id = v_id, promoted_ref = v_ref,
    promoted_at = now(), promoted_by = p_user_id, promoted_by_name = p_user_name, updated_at = now()
  WHERE p.id = v.id;
  requirement_id := v_id; requirement_ref := v_ref; already_promoted := false; title := v_title;
  RETURN NEXT;
END;
$$;

-- Issue review: Resolved / Accepted / Not Applicable (or reopen to Open).
CREATE OR REPLACE FUNCTION public.review_analysis_issue(p_issue_id uuid, p_project_id uuid, p_status text, p_note text, p_user_id uuid, p_user_name text)
RETURNS public.analysis_issues
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.analysis_issues%ROWTYPE;
BEGIN
  IF p_status NOT IN ('Open', 'Resolved', 'Accepted', 'Not Applicable') THEN RAISE EXCEPTION 'Unknown issue status %', p_status USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM public.analysis_issues i WHERE i.id = p_issue_id AND i.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found in this project' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.analysis_issues i SET status = p_status, resolution_note = coalesce(nullif(btrim(p_note), ''), i.resolution_note),
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE i.id = p_issue_id RETURNING i.* INTO v;
  RETURN v;
END;
$$;

-- Promote an issue into ONE existing governance record (human-chosen target),
-- atomically and idempotently; optionally linked (artefact_links) to the
-- canonical Requirements its related proposals were promoted into.
CREATE OR REPLACE FUNCTION public.promote_analysis_issue(p_issue_id uuid, p_project_id uuid, p_target text, p_ref_prefix text, p_fields jsonb, p_user_id uuid, p_user_name text)
RETURNS TABLE (record_id uuid, record_ref text, already_promoted boolean, target text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v public.analysis_issues%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_ref_col text;
  v_req uuid;
BEGIN
  IF p_target NOT IN ('discovery_questions', 'actions', 'risks', 'decisions') THEN RAISE EXCEPTION 'Unknown target %', p_target USING ERRCODE = '22023'; END IF;
  IF p_ref_prefix !~ '^[A-Z]{2,6}$' THEN RAISE EXCEPTION 'Invalid reference prefix' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM public.analysis_issues i WHERE i.id = p_issue_id AND i.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v.promoted_record_id IS NOT NULL THEN
    record_id := v.promoted_record_id; record_ref := v.promoted_ref; already_promoted := true; target := v.promoted_target_type;
    RETURN NEXT; RETURN;
  END IF;
  v_ref_col := CASE p_target WHEN 'discovery_questions' THEN 'question_ref' WHEN 'actions' THEN 'action_ref' WHEN 'risks' THEN 'risk_ref' ELSE 'decision_ref' END;
  PERFORM pg_advisory_xact_lock(hashtext(p_target || '-ref:' || p_project_id::text));
  EXECUTE format('SELECT %L || ''-'' || lpad((coalesce(max((substring(t.%I FROM %L))::integer), 0) + 1)::text, 3, ''0'') FROM public.%I t WHERE t.project_id = $1',
    p_ref_prefix, v_ref_col, '(?i)^' || p_ref_prefix || '-(\d+)$', p_target) INTO v_ref USING p_project_id;

  IF p_target = 'discovery_questions' THEN
    INSERT INTO public.discovery_questions (project_id, question_ref, question, category, status, owner, notes)
    VALUES (p_project_id, v_ref, p_fields->>'question', coalesce(p_fields->>'category', 'Business Rule'), 'Open', NULL, p_fields->>'notes') RETURNING id INTO v_id;
  ELSIF p_target = 'actions' THEN
    INSERT INTO public.actions (project_id, action_ref, description, status, owner, notes)
    VALUES (p_project_id, v_ref, p_fields->>'description', 'Open', NULL, p_fields->>'notes') RETURNING id INTO v_id;
  ELSIF p_target = 'risks' THEN
    INSERT INTO public.risks (project_id, risk_ref, description, impact, probability, status, owner, mitigation)
    VALUES (p_project_id, v_ref, p_fields->>'description', p_fields->>'impact', p_fields->>'probability', 'Open', NULL, NULL) RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.decisions (project_id, decision_ref, question, status, owner)
    VALUES (p_project_id, v_ref, p_fields->>'question', 'Open', NULL) RETURNING id INTO v_id;
  END IF;

  -- Canonical traceability to the Requirements this issue's proposals became (if any).
  FOR v_req IN SELECT DISTINCT p.promoted_record_id FROM public.requirement_proposals p
      WHERE p.analysis_run_id = v.analysis_run_id AND p.sequence = ANY (v.related_proposal_sequences) AND p.promoted_record_id IS NOT NULL LOOP
    INSERT INTO public.artefact_links (project_id, source_entity, source_id, target_entity, target_id) VALUES (p_project_id, 'requirements', v_req, p_target, v_id);
  END LOOP;

  UPDATE public.analysis_issues i SET promoted_target_type = p_target, promoted_record_id = v_id, promoted_ref = v_ref, promoted_at = now(),
    promoted_by_name = p_user_name, status = CASE WHEN i.status = 'Open' THEN 'Accepted' ELSE i.status END,
    resolution_note = coalesce(i.resolution_note, format('Tracked as %s.', v_ref)),
    reviewed_by = p_user_id, reviewed_by_name = p_user_name, reviewed_at = now(), updated_at = now()
  WHERE i.id = v.id;
  record_id := v_id; record_ref := v_ref; already_promoted := false; target := p_target;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_scope_note(p_note_id uuid, p_project_id uuid, p_note text, p_user_id uuid, p_user_name text)
RETURNS public.analysis_scope_notes
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v public.analysis_scope_notes%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.analysis_scope_notes n WHERE n.id = p_note_id AND n.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Scope note not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF v.acknowledged_at IS NOT NULL THEN RETURN v; END IF;
  UPDATE public.analysis_scope_notes n SET acknowledged_at = now(), acknowledged_by = p_user_id, acknowledged_by_name = p_user_name,
    acknowledgement_note = nullif(btrim(p_note), '')
  WHERE n.id = p_note_id RETURNING n.* INTO v;
  RETURN v;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.lock_proposal(uuid, uuid)',
    'public.edit_requirement_proposal(uuid, uuid, text, text, text, text, uuid, text)',
    'public.review_requirement_proposal(uuid, uuid, text, text, text, boolean, uuid, text)',
    'public.next_proposal_sequence(uuid)',
    'public.split_requirement_proposal(uuid, uuid, jsonb, uuid, text)',
    'public.merge_requirement_proposals(uuid[], uuid, text, text, text, text, uuid, text)',
    'public.promote_requirement_proposal(uuid, uuid, text, text, text, uuid, text)',
    'public.review_analysis_issue(uuid, uuid, text, text, uuid, text)',
    'public.promote_analysis_issue(uuid, uuid, text, text, jsonb, uuid, text)',
    'public.acknowledge_scope_note(uuid, uuid, text, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$$;
