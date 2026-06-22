create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  customer text not null,
  workstream text not null,
  status text not null default 'Discovery',
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requirement_ref text not null,
  title text not null,
  description text,
  priority text not null default 'Medium',
  status text not null default 'Open',
  owner text,
  source text,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.risks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  risk_ref text not null,
  description text not null,
  impact text not null default 'Medium',
  probability text not null default 'Medium',
  mitigation text,
  owner text,
  status text not null default 'Open',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  decision_ref text not null,
  question text not null,
  decision text,
  owner text,
  status text not null default 'Open',
  decision_date date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  action_ref text not null,
  description text not null,
  owner text,
  due_date date,
  status text not null default 'Open',
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.dependencies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  owner text,
  status text not null default 'Open',
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.test_cases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  test_ref text not null,
  scenario text not null,
  expected_result text,
  actual_result text,
  status text not null default 'Pending',
  owner text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  meeting_date date not null,
  title text not null,
  attendees text,
  notes text,
  decisions text,
  actions text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_name text not null,
  document_type text,
  storage_path text,
  notes text,
  uploaded_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_type text not null,
  description text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists requirements_project_id_idx on public.requirements(project_id);
create index if not exists risks_project_id_idx on public.risks(project_id);
create index if not exists decisions_project_id_idx on public.decisions(project_id);
create index if not exists actions_project_id_idx on public.actions(project_id);
create index if not exists dependencies_project_id_idx on public.dependencies(project_id);
create index if not exists test_cases_project_id_idx on public.test_cases(project_id);
create index if not exists meetings_project_id_idx on public.meetings(project_id);
create index if not exists documents_project_id_idx on public.documents(project_id);
create index if not exists activity_log_project_id_idx on public.activity_log(project_id);

create unique index if not exists projects_name_key on public.projects(name);
create unique index if not exists requirements_project_ref_key on public.requirements(project_id, requirement_ref);
create unique index if not exists risks_project_ref_key on public.risks(project_id, risk_ref);
create unique index if not exists decisions_project_ref_key on public.decisions(project_id, decision_ref);
create unique index if not exists actions_project_ref_key on public.actions(project_id, action_ref);
create unique index if not exists dependencies_project_name_key on public.dependencies(project_id, name);
create unique index if not exists test_cases_project_ref_key on public.test_cases(project_id, test_ref);
create unique index if not exists meetings_project_date_title_key on public.meetings(project_id, meeting_date, title);
create unique index if not exists documents_project_name_key on public.documents(project_id, document_name);
create unique index if not exists activity_log_project_type_description_key on public.activity_log(project_id, activity_type, description);

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at before update on public.projects for each row execute function public.set_updated_at();

drop trigger if exists set_requirements_updated_at on public.requirements;
create trigger set_requirements_updated_at before update on public.requirements for each row execute function public.set_updated_at();

drop trigger if exists set_risks_updated_at on public.risks;
create trigger set_risks_updated_at before update on public.risks for each row execute function public.set_updated_at();

drop trigger if exists set_decisions_updated_at on public.decisions;
create trigger set_decisions_updated_at before update on public.decisions for each row execute function public.set_updated_at();

drop trigger if exists set_actions_updated_at on public.actions;
create trigger set_actions_updated_at before update on public.actions for each row execute function public.set_updated_at();

drop trigger if exists set_dependencies_updated_at on public.dependencies;
create trigger set_dependencies_updated_at before update on public.dependencies for each row execute function public.set_updated_at();

drop trigger if exists set_test_cases_updated_at on public.test_cases;
create trigger set_test_cases_updated_at before update on public.test_cases for each row execute function public.set_updated_at();

drop trigger if exists set_meetings_updated_at on public.meetings;
create trigger set_meetings_updated_at before update on public.meetings for each row execute function public.set_updated_at();
