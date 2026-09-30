-- Migration 041 — Promoted Requirements cannot be deleted (Phase 1D integrity)
--
-- A canonical Requirement promoted from an AI proposal carries promotion
-- history: requirement_proposals.promoted_record_id points at it and the
-- proposal is Promoted. Migration 040 declared that FK ON DELETE SET NULL, so
-- deleting the Requirement silently cleared the link and left a Promoted
-- proposal pointing at nothing.
--
--   * A BEFORE DELETE trigger on requirements refuses, with a clear message,
--     to delete a Requirement a proposal was promoted into. It runs for every
--     path (RLS client, service role, SQL). Manually-created Requirements (no
--     proposal points at them) delete exactly as before. Deleting a whole
--     project is still allowed: by the time its cascade reaches the
--     Requirements the project row is gone (same idiom as analysis_runs_guard).
--   * The FK becomes ON DELETE NO ACTION, DEFERRABLE INITIALLY DEFERRED — the
--     backstop. It is checked at commit, so a project delete (which removes
--     the proposals further down its cascade) passes, while any delete that
--     would leave a Promoted proposal without its Requirement is rolled back.
--   * The proposal guard no longer exempts promoted_record_id on a final
--     (Promoted / Superseded) proposal: once set it can never be cleared or
--     re-pointed, so the promotion link cannot be removed to unblock a delete.
--
-- Nothing else changes: no data is modified, no proposal is reopened, RLS and
-- Requirement status/lifecycle updates are untouched.

ALTER TABLE public.requirement_proposals
  DROP CONSTRAINT requirement_proposals_promoted_record_id_fkey;
ALTER TABLE public.requirement_proposals
  ADD CONSTRAINT requirement_proposals_promoted_record_id_fkey
  FOREIGN KEY (promoted_record_id) REFERENCES public.requirements (id)
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

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
    IF OLD.promoted_record_id IS NOT NULL AND NEW.promoted_record_id IS DISTINCT FROM OLD.promoted_record_id THEN
      RAISE EXCEPTION 'a promoted proposal keeps the canonical record it created';
    END IF;
    IF OLD.review_status IN ('Promoted', 'Superseded') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
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

CREATE OR REPLACE FUNCTION public.requirements_promoted_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.requirement_proposals p WHERE p.promoted_record_id = OLD.id)
     AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = OLD.project_id) THEN
    RAISE EXCEPTION 'This Requirement was created from an approved AI proposal and cannot be deleted because its promotion history must be preserved. Change its lifecycle/status instead.'
      USING ERRCODE = '23503', CONSTRAINT = 'requirement_proposals_promoted_record_id_fkey';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.requirements_promoted_delete_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER requirements_promoted_delete_guard BEFORE DELETE ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.requirements_promoted_delete_guard();
