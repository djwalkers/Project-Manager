-- Delivery management and solution deliverable tracking.
-- Additive, non-destructive, idempotent, and safe to rerun.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  deliverable_ref text not null,
  title text not null,
  description text,
  workstream text not null,
  owner text,
  priority text not null default 'Medium',
  status text not null default 'Not Started',
  planned_completion_date date,
  actual_completion_date date,
  development_status text not null default 'Not Started',
  sit_status text not null default 'Not Started',
  uat_status text not null default 'Not Started',
  deployment_status text not null default 'Not Started',
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.deliverables add column if not exists id uuid default gen_random_uuid();
alter table public.deliverables add column if not exists project_id uuid;
alter table public.deliverables add column if not exists deliverable_ref text;
alter table public.deliverables add column if not exists title text;
alter table public.deliverables add column if not exists description text;
alter table public.deliverables add column if not exists workstream text;
alter table public.deliverables add column if not exists owner text;
alter table public.deliverables add column if not exists priority text default 'Medium';
alter table public.deliverables add column if not exists status text default 'Not Started';
alter table public.deliverables add column if not exists planned_completion_date date;
alter table public.deliverables add column if not exists actual_completion_date date;
alter table public.deliverables add column if not exists development_status text default 'Not Started';
alter table public.deliverables add column if not exists sit_status text default 'Not Started';
alter table public.deliverables add column if not exists uat_status text default 'Not Started';
alter table public.deliverables add column if not exists deployment_status text default 'Not Started';
alter table public.deliverables add column if not exists notes text;
alter table public.deliverables add column if not exists created_at timestamptz default timezone('utc', now());
alter table public.deliverables add column if not exists updated_at timestamptz default timezone('utc', now());

create index if not exists deliverables_project_id_idx on public.deliverables(project_id);
create index if not exists deliverables_status_idx on public.deliverables(status);
create index if not exists deliverables_planned_completion_idx on public.deliverables(planned_completion_date);
create unique index if not exists deliverables_project_ref_key on public.deliverables(project_id, deliverable_ref);

drop trigger if exists set_deliverables_updated_at on public.deliverables;
create trigger set_deliverables_updated_at before update on public.deliverables for each row execute function public.set_updated_at();

-- Temporary development access until authentication and production RLS policies are introduced.
alter table public.deliverables disable row level security;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.deliverables to anon, authenticated;
