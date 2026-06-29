-- Extend project_snapshots with delivery intelligence fields
ALTER TABLE public.project_snapshots
  ADD COLUMN IF NOT EXISTS delivery_confidence  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS project_readiness    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requirements_complete integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS acceptance_complete  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence_complete    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sign_off_complete    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_actions      integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS high_risks           integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outstanding_dependencies integer DEFAULT 0;

-- RLS: anon can read snapshots for their project (already open via 015)
-- No new policy needed — existing SELECT policies on project_snapshots cover this.
