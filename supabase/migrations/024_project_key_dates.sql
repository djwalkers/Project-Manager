-- 024: Authoritative project date fields.
--
-- Additive, nullable columns only — no backfill. Existing rows get NULL for
-- all four; every consumer already falls back correctly when these are
-- unset (see lib/project-dates.ts's resolveGoLiveDate precedence: a live
-- "Go Live" milestone, then go_live_date, then planned_end_date, then
-- none). uat_complete_date/hypercare_start_date/hypercare_end_date are not
-- yet consumed anywhere — they exist so a date can be recorded explicitly
-- once a resolver for those concepts is introduced in a later phase,
-- without requiring another schema change.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS go_live_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS uat_complete_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hypercare_start_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hypercare_end_date date;
