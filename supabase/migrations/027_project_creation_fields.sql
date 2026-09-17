-- 027: Project reference/code and owner fields, for the "Create New
-- Project" workflow.
--
-- Additive, nullable columns only — no backfill. CR028's existing row gets
-- NULL for both; its reference has only ever been a substring of `name`
-- ("CR 28 Multi Delivery Dates" / "CR028 - Delivery Date Range") with no
-- dedicated column (see lib/project-scope.ts's normalizedProjectName-based
-- matching, unaffected by this migration). Set CR028's project_ref/owner
-- through the app once this migration has been applied, if desired.
--
-- project_ref is deliberately NOT NOT-NULL and has no app-level auto-
-- generation — every future project (PL10 included) supplies its own
-- reference at creation time (see lib/project-creation.ts). A plain unique
-- index is sufficient: Postgres treats multiple NULLs as non-conflicting,
-- so existing rows without a reference never collide with each other or
-- with a newly-created project's reference.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_ref text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner text;

CREATE UNIQUE INDEX IF NOT EXISTS projects_project_ref_key ON projects (project_ref);
