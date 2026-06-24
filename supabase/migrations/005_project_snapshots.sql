-- Daily project health and control metric history.
-- Additive, non-destructive, idempotent, and safe to rerun.

create extension if not exists "pgcrypto";

create table if not exists public.project_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  snapshot_date date not null,
  project_health text not null,
  schedule_health text not null,
  progress_percent numeric not null default 0,
  schedule_variance numeric not null default 0,
  open_risks integer not null default 0,
  open_actions integer not null default 0,
  overdue_actions integer not null default 0,
  open_decisions integer not null default 0,
  overdue_decisions integer not null default 0,
  open_questions integer not null default 0,
  active_milestone text,
  active_phase text,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.project_snapshots add column if not exists id uuid default gen_random_uuid();
alter table public.project_snapshots add column if not exists project_id uuid;
alter table public.project_snapshots add column if not exists snapshot_date date;
alter table public.project_snapshots add column if not exists project_health text;
alter table public.project_snapshots add column if not exists schedule_health text;
alter table public.project_snapshots add column if not exists progress_percent numeric default 0;
alter table public.project_snapshots add column if not exists schedule_variance numeric default 0;
alter table public.project_snapshots add column if not exists open_risks integer default 0;
alter table public.project_snapshots add column if not exists open_actions integer default 0;
alter table public.project_snapshots add column if not exists overdue_actions integer default 0;
alter table public.project_snapshots add column if not exists open_decisions integer default 0;
alter table public.project_snapshots add column if not exists overdue_decisions integer default 0;
alter table public.project_snapshots add column if not exists open_questions integer default 0;
alter table public.project_snapshots add column if not exists active_milestone text;
alter table public.project_snapshots add column if not exists active_phase text;
alter table public.project_snapshots add column if not exists created_at timestamptz default timezone('utc', now());

create index if not exists project_snapshots_project_id_idx on public.project_snapshots(project_id);
create index if not exists project_snapshots_snapshot_date_idx on public.project_snapshots(snapshot_date);
create unique index if not exists project_snapshots_project_date_key on public.project_snapshots(project_id, snapshot_date);

-- Temporary development access until authentication and production RLS policies are introduced.
alter table public.project_snapshots disable row level security;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.project_snapshots to anon, authenticated;
