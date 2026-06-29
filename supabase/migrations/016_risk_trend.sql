-- 016: Add optional trend column to the risks table
-- Allows risk owners to record whether a risk is Improving, Stable or Worsening
-- over time. Existing rows default to NULL (unset — no schema change required).

ALTER TABLE risks ADD COLUMN IF NOT EXISTS trend text DEFAULT NULL;
