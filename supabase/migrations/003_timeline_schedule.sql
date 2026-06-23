-- Editable project schedule and timeline phases.
-- Additive, non-destructive, and safe to rerun.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

alter table public.projects add column if not exists planned_start_date date;
alter table public.projects add column if not exists planned_end_date date;

create table if not exists public.timeline_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  phase_ref text not null,
  phase_name text not null,
  start_date date not null,
  end_date date not null,
  owner text,
  status text not null default 'Not Started',
  progress_percent integer not null default 0,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.timeline_items add column if not exists id uuid default gen_random_uuid();
alter table public.timeline_items add column if not exists project_id uuid;
alter table public.timeline_items add column if not exists phase_ref text;
alter table public.timeline_items add column if not exists phase_name text;
alter table public.timeline_items add column if not exists start_date date;
alter table public.timeline_items add column if not exists end_date date;
alter table public.timeline_items add column if not exists owner text;
alter table public.timeline_items add column if not exists status text default 'Not Started';
alter table public.timeline_items add column if not exists progress_percent integer default 0;
alter table public.timeline_items add column if not exists notes text;
alter table public.timeline_items add column if not exists created_at timestamptz default timezone('utc', now());
alter table public.timeline_items add column if not exists updated_at timestamptz default timezone('utc', now());

create index if not exists timeline_items_project_id_idx on public.timeline_items(project_id);
create index if not exists timeline_items_start_date_idx on public.timeline_items(start_date);
create unique index if not exists timeline_items_project_ref_key on public.timeline_items(project_id, phase_ref);

drop trigger if exists set_timeline_items_updated_at on public.timeline_items;
create trigger set_timeline_items_updated_at
before update on public.timeline_items
for each row execute function public.set_updated_at();
