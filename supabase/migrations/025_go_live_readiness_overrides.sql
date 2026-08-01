-- 025: Go-Live Readiness overrides (Phase 6).
--
-- Audit-style override records for the 7 auto-derived Go-Live Readiness
-- checks. The lifecycle-derived status is never stored here — only the
-- human override and its audit trail (reason, who, when). One row per
-- (project_id, check_key); deleting a row immediately restores the
-- live-derived status, since lib/go-live-readiness.ts always recomputes the
-- derived status fresh and only looks up an override to see if one exists.
--
-- Served exclusively through the authenticated Next.js API route
-- app/api/go-live/overrides, using the service-role client, exactly like
-- go_live_checklists and cutover_plan (see 023_go_live_security_hardening).
-- RLS is enabled with no policies at all — service_role bypasses RLS
-- regardless, and no anon/authenticated-role policy is needed or added.

CREATE TABLE IF NOT EXISTS go_live_readiness_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  check_key         text NOT NULL,
  override_status   text NOT NULL,
  override_reason   text NOT NULL,
  overridden_by     text NOT NULL,
  overridden_at     timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, check_key)
);

ALTER TABLE go_live_readiness_overrides ENABLE ROW LEVEL SECURITY;
