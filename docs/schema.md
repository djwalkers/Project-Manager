# CR028 schema authority

The application schema version is `005_project_snapshots`. The executable contract is defined in `lib/schema.ts`; migration 005 adds daily project history for trends and management comparisons.

`Required` means the canonical database definition is `NOT NULL`. All child-table `project_id` columns reference `projects.id` with `ON DELETE CASCADE`.

## Tables

### projects

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| name | text | Yes | — |
| customer | text | Yes | — |
| workstream | text | Yes | — |
| status | text | Yes | — |
| health | text | Yes | — |
| schedule_variance | numeric | Yes | — |
| planned_start_date | date | No | — |
| planned_end_date | date | No | — |
| description | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### requirements

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| requirement_ref | text | Yes | — |
| title | text | Yes | — |
| description | text | No | — |
| priority | text | Yes | — |
| category | text | Yes | — |
| status | text | Yes | — |
| owner | text | No | — |
| source | text | No | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### risks

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| risk_ref | text | Yes | — |
| description | text | Yes | — |
| impact | text | Yes | — |
| probability | text | Yes | — |
| mitigation | text | No | — |
| owner | text | No | — |
| status | text | Yes | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### decisions

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| decision_ref | text | Yes | — |
| question | text | Yes | — |
| decision | text | No | — |
| owner | text | No | — |
| status | text | Yes | — |
| decision_date | date | No | — |
| due_date | date | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### actions

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| action_ref | text | Yes | — |
| description | text | Yes | — |
| owner | text | No | — |
| due_date | date | No | — |
| status | text | Yes | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### dependencies

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| name | text | Yes | — |
| owner | text | No | — |
| status | text | Yes | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### discovery_questions

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| question_ref | text | Yes | — |
| question | text | Yes | — |
| owner | text | No | — |
| category | text | Yes | — |
| status | text | Yes | — |
| due_date | date | No | — |
| answer | text | No | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### milestones

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| milestone_ref | text | Yes | — |
| title | text | Yes | — |
| target_date | date | No | — |
| status | text | Yes | — |
| owner | text | No | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### timeline_items

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| phase_ref | text | Yes | — |
| phase_name | text | Yes | — |
| start_date | date | Yes | — |
| end_date | date | Yes | — |
| owner | text | No | — |
| status | text | Yes | — |
| progress_percent | integer | Yes | — |
| notes | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### project_snapshots

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| snapshot_date | date | Yes | — |
| project_health | text | Yes | — |
| schedule_health | text | Yes | — |
| progress_percent | numeric | Yes | — |
| schedule_variance | numeric | Yes | — |
| open_risks | integer | Yes | — |
| open_actions | integer | Yes | — |
| overdue_actions | integer | Yes | — |
| open_decisions | integer | Yes | — |
| overdue_decisions | integer | Yes | — |
| open_questions | integer | Yes | — |
| active_milestone | text | No | — |
| active_phase | text | No | — |
| created_at | timestamptz | Yes | — |

### test_cases

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| test_ref | text | Yes | — |
| scenario | text | Yes | — |
| expected_result | text | No | — |
| actual_result | text | No | — |
| status | text | Yes | — |
| owner | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### meetings

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| meeting_date | date | Yes | — |
| title | text | Yes | — |
| attendees | text | No | — |
| notes | text | No | — |
| decisions | text | No | — |
| actions | text | No | — |
| created_at | timestamptz | Yes | — |
| updated_at | timestamptz | Yes | — |

### documents

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| document_name | text | Yes | — |
| document_type | text | No | — |
| storage_path | text | No | — |
| notes | text | No | — |
| uploaded_at | timestamptz | Yes | — |

### activity_log

| Column | PostgreSQL type | Required | Foreign key |
| --- | --- | --- | --- |
| id | uuid | Yes | — |
| project_id | uuid | Yes | projects.id |
| activity_type | text | Yes | — |
| description | text | Yes | — |
| created_at | timestamptz | Yes | — |

## Application alignment

- CRUD form fields and list columns are declared in `lib/modules.ts` and checked against the canonical schema by the System Health page.
- Supabase writable-column allowlists are generated from `lib/schema.ts`; database-managed IDs and timestamps cannot accidentally be sent by CRUD forms.
- TypeScript nullable fields now match nullable database columns. Required references, titles, statuses, categories, descriptions, and project fields remain non-nullable.
- `id`, `created_at`, `updated_at`, and `uploaded_at` are database-managed and therefore not editable in the UI. `project_id` is assigned by the data layer for the current project rather than exposed in forms.
- Activity log is read-only by design. Documents supports metadata CRUD; file upload/storage remains a placeholder.

## Relationships

`projects` is the parent aggregate. Requirements, risks, decisions, actions, dependencies, discovery questions, milestones, timeline items, project snapshots, test cases, meetings, documents, and activity entries each belong to one project through `project_id`. Deleting a project cascades to its children in a database created from the authoritative migration.

## Seed strategy

Run `supabase/seed_full_cr028.sql` after the migrations. It seeds the CR028 project plus requirements, risks, decisions, discovery questions, actions, dependencies, milestones, timeline items, and test cases. Timeline seed dates are editable starting values, not calculation constants. Stable natural references are protected by unique indexes and used by `ON CONFLICT` upserts, so rerunning the seed updates CR028 rather than duplicating it. Meetings, document metadata, and activity history are intentionally excluded from the full baseline seed.

## Migration strategy

1. Keep `001_initial_schema.sql` as historical/bootstrap context.
2. Run `002_schema_alignment.sql` to align the original control tables.
3. Run `003_timeline_schedule.sql` to add project planned dates and `timeline_items`. It uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and never drops columns or rows.
4. Run `004_timeline_visibility_and_project_reconciliation.sql`. While authentication is absent, it disables RLS for `timeline_items`, grants development CRUD access to the anon client, and reparents stranded phases to the CR028 project with the strongest control-data ownership without deleting duplicate projects.
5. Run `005_project_snapshots.sql` to add the idempotent daily snapshot table, unique project/day key, indexes, and temporary development grants.
6. Run `seed_full_cr028.sql` after migration 005.
7. Use the System Health page to verify table accessibility, expected column presence, connection mode, record counts, duplicate CR028 projects, and timeline visibility.

Because PostgreSQL cannot safely infer how to repair arbitrary legacy data, additive migrations do not coerce existing column types, remove obsolete columns, or force new nullable legacy columns to `NOT NULL`. Likewise, a unique index cannot be created if an older database already contains duplicate natural keys. Those cases require a reviewed data-cleanup migration. The browser-side Supabase client can detect missing/inaccessible tables and columns, but not inspect constraints, exact types, foreign keys, or applied migration history through the anonymous API.

Authentication and production row-level security remain intentionally out of scope. Migration 004 contains an explicit temporary development grant for `timeline_items`; replace it with authenticated RLS policies before production use.
