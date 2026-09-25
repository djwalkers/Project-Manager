-- 033: Acceptance Criteria integrity (Phase 0C).
--
-- Hierarchy: Project → Requirement → Acceptance Criterion → Test (via
-- artefact_links). This migration makes the database enforce it without
-- changing any existing row.
--
-- 1. An AC must belong to a Requirement — CHECK (requirement_id IS NOT NULL)
--    added NOT VALID: every INSERT and UPDATE is checked from now on (no new
--    orphan, and no valid AC can be turned into one), while the seven
--    pre-existing CR 28 orphans (AC-001..AC-007) are left untouched until
--    they are assigned through the UI. Once none remain:
--      ALTER TABLE public.acceptance_criteria
--        VALIDATE CONSTRAINT acceptance_criteria_requirement_required;
--      ALTER TABLE public.acceptance_criteria ALTER COLUMN requirement_id SET NOT NULL;
--
-- 2. Same project — the single-column FK (requirement_id → requirements.id,
--    ON DELETE CASCADE) is replaced by a composite FK
--    (requirement_id, project_id) → requirements(id, project_id), backed by
--    a unique constraint on requirements(id, project_id). It still
--    guarantees requirement_id references requirements.id, and also that the
--    Requirement is in the AC's own project. acceptance_criteria.project_id
--    becomes NOT NULL (no live row is NULL) so the check can never be skipped.
--
-- 3. Requirement deletion no longer silently destroys history. Both the AC
--    and the sign-off relationships become ON DELETE NO ACTION: deleting a
--    Requirement that still has Acceptance Criteria or sign-offs fails.
--    NO ACTION (rather than RESTRICT) is checked at the end of the statement,
--    so deleting a whole project (Admin only) still cascades cleanly.
--
-- 4. Traceability links are removed with the record they point at. An AFTER
--    DELETE row trigger on requirements and acceptance_criteria deletes the
--    artefact_links whose source or target is the deleted row, in the same
--    statement and transaction — a refused delete removes no links.
--
-- Unchanged: evidence.ac_id → acceptance_criteria ON DELETE CASCADE (a
-- deliberate AC delete still removes its own evidence), RLS policies (031),
-- artefact_links semantics, and every calculation.

-- ── 1. Requirement required (transitional, NOT VALID) ──────────────────────

ALTER TABLE public.acceptance_criteria
  ADD CONSTRAINT acceptance_criteria_requirement_required
  CHECK (requirement_id IS NOT NULL) NOT VALID;

-- ── 2. Same-project composite foreign key ──────────────────────────────────

ALTER TABLE public.requirements
  ADD CONSTRAINT requirements_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE public.acceptance_criteria ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE public.acceptance_criteria
  DROP CONSTRAINT acceptance_criteria_requirement_id_fkey;

ALTER TABLE public.acceptance_criteria
  ADD CONSTRAINT acceptance_criteria_requirement_same_project_fkey
  FOREIGN KEY (requirement_id, project_id)
  REFERENCES public.requirements (id, project_id)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION;

-- ── 3. Sign-offs protect their Requirement ─────────────────────────────────

ALTER TABLE public.requirement_sign_offs
  DROP CONSTRAINT requirement_sign_offs_requirement_id_fkey;

ALTER TABLE public.requirement_sign_offs
  ADD CONSTRAINT requirement_sign_offs_requirement_id_fkey
  FOREIGN KEY (requirement_id)
  REFERENCES public.requirements (id)
  ON DELETE NO ACTION;

-- ── 4. No dangling traceability links ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_artefact_links_for_deleted_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only ever removes links that point at the row just deleted. TG_TABLE_NAME
  -- matches artefact_links' entity names ('requirements', 'acceptance_criteria').
  DELETE FROM public.artefact_links l
  WHERE (l.source_entity = TG_TABLE_NAME AND l.source_id = OLD.id)
     OR (l.target_entity = TG_TABLE_NAME AND l.target_id = OLD.id);
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_artefact_links_for_deleted_row() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS requirements_delete_links ON public.requirements;
CREATE TRIGGER requirements_delete_links
  AFTER DELETE ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.delete_artefact_links_for_deleted_row();

DROP TRIGGER IF EXISTS acceptance_criteria_delete_links ON public.acceptance_criteria;
CREATE TRIGGER acceptance_criteria_delete_links
  AFTER DELETE ON public.acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION public.delete_artefact_links_for_deleted_row();
