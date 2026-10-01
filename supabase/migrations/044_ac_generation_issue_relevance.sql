-- 044: AC generation — requirement-specific issue and scope-note relevance,
-- and blocking vs non-blocking open questions (Phase 1E quality fix).
--
-- * Relevance (ac_generation_input):
--   - an analysis issue tied to proposals counts only for those proposals'
--     split/merge lineage (unchanged);
--   - an issue tied to NO proposal counts only when its verbatim trigger
--     sentence is part of THIS Requirement's own statement (its promoted
--     proposal's source quotes or reviewed description). Sharing a broad
--     fragment that holds a whole change request is no longer enough;
--   - an acknowledged scope note is supplied only when its own statement is
--     part of the Requirement's statement. A change-level note ("X remains as
--     it is") stays at change level — preserved in the analysis run for later
--     regression-test generation — instead of contaminating every Requirement.
-- * ac_generation_issues.relation records how an open analysis question
--   relates to the generated criteria: 'Blocking' (a criterion's expected
--   result depends on the answer → that criterion is Needs Review),
--   'Additional Coverage' (related, does not block; a further criterion may be
--   needed once answered), 'Informational'. NULL on runs before 044.
-- * Existing generation runs, their snapshots and output are not touched.

ALTER TABLE public.ac_generation_issues
  ADD COLUMN relation text CHECK (relation IS NULL OR relation IN ('Blocking', 'Additional Coverage', 'Informational'));

-- Whitespace/quote/dash/case-insensitive form used for "is part of" checks.
CREATE OR REPLACE FUNCTION public.ac_generation_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT btrim(regexp_replace(lower(translate(coalesce(p, ''), '‘’´`“”‐‑‒–—', '''''''''""-----')), '\s+', ' ', 'g'), ' "''.,;:…-')
$$;

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

  -- THIS Requirement's own statement: its proposal's verbatim quotes (and its
  -- consolidated members') and the reviewed description.
  v_quotes := ARRAY(SELECT DISTINCT q FROM (
    SELECT v_p.source_quote AS q UNION ALL
    SELECT m->>'quote' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_p.consolidation->'members') = 'array' THEN v_p.consolidation->'members' ELSE '[]'::jsonb END) m
  ) x WHERE nullif(btrim(q), '') IS NOT NULL);
  v_own := public.ac_generation_norm(array_to_string(v_quotes || coalesce(v_p.reviewed_description, v_p.proposed_description), ' ¦ '));

  -- Analysis issues about THIS Requirement: tied to its lineage, or tied to
  -- no proposal and raised by a sentence of its own statement. A human
  -- resolution (Resolved/Accepted with a note) is a clarification; an issue
  -- still Open (or Accepted without an answer) is an open question.
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
  -- Acknowledged scope notes whose own statement is part of this Requirement's
  -- statement. Change-level notes stay with the analysis run.
  scope_note_ids := ARRAY(
    SELECT n.id FROM public.analysis_scope_notes n
    WHERE n.analysis_run_id = v_p.analysis_run_id AND n.acknowledged_at IS NOT NULL AND n.source_fragment_ids && v_p.source_fragment_ids
      AND length(public.ac_generation_norm(coalesce(n.source_quote, n.description))) >= 8
      AND strpos(v_own, public.ac_generation_norm(coalesce(n.source_quote, n.description))) > 0
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

-- Same as 043, plus the issue relation.
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
    suggested_question, source_fragment_ids, analysis_issue_ids, related_proposal_sequences, relation)
  SELECT p_run_id, v_run.project_id, v_run.requirement_id, (i.ord)::integer, i.v->>'issue_type', i.v->>'severity', i.v->>'description', i.v->>'obligation',
    i.v->>'suggested_question',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'source_fragment_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'analysis_issue_ids', '[]'::jsonb)))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i.v->'related_proposal_sequences', '[]'::jsonb)))::integer[],
    nullif(i.v->>'relation', '')
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

REVOKE ALL ON FUNCTION public.ac_generation_norm(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ac_generation_norm(text) TO service_role;
REVOKE ALL ON FUNCTION public.ac_generation_input(uuid, uuid), public.complete_ac_generation_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ac_generation_input(uuid, uuid), public.complete_ac_generation_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) TO service_role;
