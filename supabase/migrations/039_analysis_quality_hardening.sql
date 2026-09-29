-- 039: Requirement-analysis quality hardening (Phase 1C, prompts/schema 2.0.0).
--
-- * Scope / regression notes: "No change required" statements are kept as
--   analysis metadata with provenance — not as requirement proposals — so
--   they are available for regression planning without inflating the
--   requirement count. Same guarantees as proposals and issues: every note
--   cites at least one fragment of the run's OWN extraction job (the 038
--   provenance trigger), notes are immutable, Manager/Admin read only,
--   service-role writes, anon nothing.
-- * Issues gain the material impact that justifies them, the verbatim
--   source words that triggered them, and consolidation evidence when
--   several questions were merged (all their sources and proposal links are
--   kept on the merged issue).
-- * New stage names for the resumable stage results: 'coverage' (statements
--   the first pass left uncaptured) and 'source_check' (is a question
--   already answered elsewhere in the document?).
-- * complete_analysis_run gains a scope-notes argument. The 038 signature
--   stays as a wrapper (no notes) so an already-deployed worker/app keeps
--   working until it is updated.
-- Existing runs, proposals and issues are unchanged: new columns are
-- nullable or default to empty, and nothing is back-filled.

ALTER TABLE public.analysis_stage_results DROP CONSTRAINT IF EXISTS analysis_stage_results_stage_check;
ALTER TABLE public.analysis_stage_results ADD CONSTRAINT analysis_stage_results_stage_check
  CHECK (stage IN ('classification', 'requirements', 'coverage', 'ambiguities', 'consolidation', 'source_check'));

ALTER TABLE public.analysis_runs ADD COLUMN IF NOT EXISTS scope_note_count integer;

ALTER TABLE public.analysis_issues ADD COLUMN IF NOT EXISTS impact text[] NOT NULL DEFAULT '{}'
  CHECK (impact <@ ARRAY['implementation', 'test_design', 'acceptance_criteria', 'data_migration', 'integration', 'scope', 'operational']::text[]);
ALTER TABLE public.analysis_issues ADD COLUMN IF NOT EXISTS trigger_quote text CHECK (length(trigger_quote) <= 400);
ALTER TABLE public.analysis_issues ADD COLUMN IF NOT EXISTS consolidation jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE public.analysis_scope_notes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id     uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),
  note_type           text        NOT NULL DEFAULT 'No Change' CHECK (note_type IN ('No Change')),
  area                text        CHECK (length(area) <= 300),
  description         text        NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  source_quote        text        CHECK (length(source_quote) <= 2000),
  source_fragment_ids uuid[]      NOT NULL CHECK (cardinality(source_fragment_ids) >= 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_scope_notes_run_fkey FOREIGN KEY (analysis_run_id, project_id) REFERENCES public.analysis_runs (id, project_id) ON DELETE CASCADE,
  CONSTRAINT analysis_scope_notes_run_sequence_key UNIQUE (analysis_run_id, sequence)
);
CREATE INDEX analysis_scope_notes_run_idx ON public.analysis_scope_notes (analysis_run_id, sequence);

CREATE TRIGGER analysis_scope_notes_provenance BEFORE INSERT OR UPDATE OF source_fragment_ids ON public.analysis_scope_notes
  FOR EACH ROW EXECUTE FUNCTION public.analysis_output_provenance_guard();

CREATE OR REPLACE FUNCTION public.analysis_scope_notes_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'scope notes record what the analysis found and cannot be changed';
END;
$$;
CREATE TRIGGER analysis_scope_notes_immutable BEFORE UPDATE ON public.analysis_scope_notes
  FOR EACH ROW EXECUTE FUNCTION public.analysis_scope_notes_immutable();

-- Worker: finish its running run with validated proposals, issues and scope
-- notes, atomically. Review status is decided here: Inferred → 'Needs Review'.
CREATE OR REPLACE FUNCTION public.complete_analysis_run(p_run_id uuid, p_worker_id uuid, p_model_digest text, p_proposals jsonb, p_issues jsonb, p_scope_notes jsonb, p_diagnostics jsonb, p_with_warnings boolean)
RETURNS TABLE (project_id uuid, document_version_id uuid, status text, proposal_count integer, issue_count integer, scope_note_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_run public.analysis_runs%ROWTYPE;
  v_status text;
  v_p integer;
  v_i integer;
  v_n integer;
BEGIN
  v_run := public.assert_analysis_run_owner(p_run_id, p_worker_id);
  IF jsonb_typeof(p_proposals) <> 'array' OR jsonb_typeof(p_issues) <> 'array' OR jsonb_typeof(p_scope_notes) <> 'array' THEN
    RAISE EXCEPTION 'proposals, issues and scope notes must be arrays' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_proposals x WHERE x.analysis_run_id = p_run_id)
     OR EXISTS (SELECT 1 FROM public.analysis_issues x WHERE x.analysis_run_id = p_run_id)
     OR EXISTS (SELECT 1 FROM public.analysis_scope_notes x WHERE x.analysis_run_id = p_run_id) THEN
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

  INSERT INTO public.analysis_issues (analysis_run_id, project_id, sequence, issue_type, severity, description, suggested_question, source_fragment_ids,
    related_proposal_sequences, impact, trigger_quote, consolidation)
  SELECT p_run_id, v_run.project_id, (i.ord)::integer, i.v->>'issue_type', i.v->>'severity', i.v->>'description', i.v->>'suggested_question',
    ARRAY(SELECT jsonb_array_elements_text(i.v->'source_fragment_ids'))::uuid[],
    coalesce(ARRAY(SELECT jsonb_array_elements_text(i.v->'related_proposal_sequences'))::integer[], '{}'),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(i.v->'impact')), '{}'), i.v->>'trigger_quote', coalesce(i.v->'consolidation', '{}'::jsonb)
  FROM jsonb_array_elements(p_issues) WITH ORDINALITY AS i(v, ord);
  GET DIAGNOSTICS v_i = ROW_COUNT;

  INSERT INTO public.analysis_scope_notes (analysis_run_id, project_id, sequence, note_type, area, description, source_quote, source_fragment_ids)
  SELECT p_run_id, v_run.project_id, (n.ord)::integer, coalesce(n.v->>'note_type', 'No Change'), n.v->>'area', n.v->>'description', n.v->>'source_quote',
    ARRAY(SELECT jsonb_array_elements_text(n.v->'source_fragment_ids'))::uuid[]
  FROM jsonb_array_elements(p_scope_notes) WITH ORDINALITY AS n(v, ord);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  v_status := CASE WHEN p_with_warnings THEN 'Completed with warnings' ELSE 'Completed' END;
  UPDATE public.analysis_runs r SET status = v_status, completed_at = now(), lease_expires_at = NULL, model_digest = left(p_model_digest, 100),
    diagnostics = p_diagnostics, proposal_count = v_p, issue_count = v_i, scope_note_count = v_n,
    warnings_count = coalesce(jsonb_array_length(p_diagnostics->'warnings'), 0)
  WHERE r.id = p_run_id;
  project_id := v_run.project_id; document_version_id := v_run.document_version_id; status := v_status;
  proposal_count := v_p; issue_count := v_i; scope_note_count := v_n;
  RETURN NEXT;
END;
$$;

-- The 038 signature stays (no scope notes) for already-deployed code.
CREATE OR REPLACE FUNCTION public.complete_analysis_run(p_run_id uuid, p_worker_id uuid, p_model_digest text, p_proposals jsonb, p_issues jsonb, p_diagnostics jsonb, p_with_warnings boolean)
RETURNS TABLE (project_id uuid, document_version_id uuid, status text, proposal_count integer, issue_count integer)
LANGUAGE sql SET search_path = '' AS $$
  SELECT c.project_id, c.document_version_id, c.status, c.proposal_count, c.issue_count
  FROM public.complete_analysis_run(p_run_id, p_worker_id, p_model_digest, p_proposals, p_issues, '[]'::jsonb, p_diagnostics, p_with_warnings) c;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_run(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, boolean), public.complete_analysis_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_analysis_run(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, boolean), public.complete_analysis_run(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.analysis_scope_notes_immutable() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.analysis_scope_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "analysis_scope_notes_select" ON public.analysis_scope_notes FOR SELECT TO authenticated USING ((SELECT public.can_write()));
REVOKE ALL ON public.analysis_scope_notes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.analysis_scope_notes FROM authenticated;
