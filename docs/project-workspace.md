# Project Workspace

The Project Workspace is the single-project operational view at `/project-workspace`. It combines delivery status, timeline health, attention items, decisions, discovery questions, actions, risks, milestones, recent activity, and an automatically generated narrative.

## Project selection

The workspace starts with the app's canonical active project and stores subsequent project choices in browser local storage under `project-manager-selected-project-id`. Daily Brief project cards can open the workspace with the corresponding project selected. Selection does not require authentication or a database schema change.

## Data and persistence

All workspace reads use the existing project-scoped data model. Quick actions, inline edits, and action status changes use the shared Supabase data store when Supabase is configured and the localStorage fallback otherwise. Workspace changes also create `activity_log` entries where possible; a primary record remains saved if activity logging fails.

The workspace uses these existing tables:

- `projects`
- `timeline_items`
- `requirements`
- `risks`
- `decisions`
- `actions`
- `discovery_questions`
- `milestones`
- `activity_log`

No additional migration is required.

## Operational calculations

- Project health, progress, and attention items reuse the Control Tower calculations.
- Schedule health, planned progress, actual progress, variance, phases, and days remaining reuse the timeline schedule service.
- Upcoming milestones include incomplete milestones due within 14 days.
- The action board groups `Complete` and `Closed` together; all other non-progress statuses appear in Open.
- Workspace warnings identify missing operational controls such as timeline phases, milestones, requirements, decisions, actions, and discovery questions.

