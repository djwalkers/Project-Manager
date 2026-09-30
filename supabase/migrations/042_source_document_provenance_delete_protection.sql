-- Migration 042 — Source documents that promoted Requirements came from cannot
-- be permanently deleted (Phase 1D integrity)
--
-- Permanently deleting a document cascades documents → document_versions →
-- extraction_jobs → analysis_runs → requirement_proposals. If any of those
-- proposals was promoted, the canonical Requirement survived (migration 041)
-- but lost its source provenance.
--
--   * A BEFORE DELETE guard on documents refuses the delete while ANY version
--     of the document has an analysis run with a Promoted proposal (or one
--     that carries a promoted_record_id). It walks the full chain, so the
--     version that produced the promotion does not matter. It runs for every
--     path (service role, SQL). Versions, extraction jobs and analysis runs
--     already refuse deletion on their own (migrations 035/036/038), so the
--     document delete is the only way into this cascade.
--   * Deleting a whole project is still allowed: by the time its cascade
--     reaches the documents the project row is gone (same idiom as 041), and
--     the project's Requirements and proposals go with it.
--
-- Nothing else changes: no data is modified, archiving and reading archived
-- documents are untouched, documents without promoted proposals delete as
-- before, and promotion itself is unchanged.

CREATE OR REPLACE FUNCTION public.documents_promoted_provenance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.document_versions v
       JOIN public.extraction_jobs j ON j.document_version_id = v.id
       JOIN public.analysis_runs r ON r.extraction_job_id = j.id
       JOIN public.requirement_proposals p ON p.analysis_run_id = r.id
       WHERE v.document_id = OLD.id
         AND (p.review_status = 'Promoted' OR p.promoted_record_id IS NOT NULL))
     AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
    RAISE EXCEPTION 'This source document cannot be permanently deleted because one or more promoted Requirements depend on its analysis provenance. Keep it archived instead.'
      USING ERRCODE = '23001';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.documents_promoted_provenance_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER documents_promoted_provenance_guard BEFORE DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_promoted_provenance_guard();
