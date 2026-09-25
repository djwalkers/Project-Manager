-- 034: finalise "every Acceptance Criterion belongs to a Requirement".
--
-- Migration 033 added CHECK (requirement_id IS NOT NULL) as NOT VALID so the
-- seven legacy CR 28 orphans (AC-001..AC-007) could be repaired through the
-- UI first. They have been assigned (AC-001..005 → REP-016, AC-006 →
-- REP-001, AC-007 → REP-010), so no orphan remains: validate the constraint
-- and make the column NOT NULL. Nothing else changes — the same-project
-- composite FK, ON DELETE behaviour, evidence cascade and the
-- artefact_links delete trigger are untouched.

ALTER TABLE public.acceptance_criteria
  VALIDATE CONSTRAINT acceptance_criteria_requirement_required;

ALTER TABLE public.acceptance_criteria
  ALTER COLUMN requirement_id SET NOT NULL;
