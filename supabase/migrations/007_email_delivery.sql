-- Automated email settings and auditable delivery history.
-- Additive, non-destructive, idempotent, and safe to rerun.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create table if not exists public.email_settings (
  id uuid primary key default gen_random_uuid(),
  daily_brief_enabled boolean not null default false,
  weekly_summary_enabled boolean not null default false,
  recipient_email text not null default 'Andrew.Walker@bluestonex.com',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.email_settings add column if not exists daily_brief_enabled boolean default false;
alter table public.email_settings add column if not exists weekly_summary_enabled boolean default false;
alter table public.email_settings add column if not exists recipient_email text default 'Andrew.Walker@bluestonex.com';
alter table public.email_settings add column if not exists created_at timestamptz default timezone('utc', now());
alter table public.email_settings add column if not exists updated_at timestamptz default timezone('utc', now());

drop trigger if exists set_email_settings_updated_at on public.email_settings;
create trigger set_email_settings_updated_at before update on public.email_settings for each row execute function public.set_updated_at();

create table if not exists public.email_activity_log (
  id uuid primary key default gen_random_uuid(),
  email_type text not null,
  recipient text not null,
  sent_at timestamptz not null default timezone('utc', now()),
  success boolean not null default false,
  failure_reason text,
  duration_ms integer not null default 0,
  trigger_type text not null,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.email_activity_log add column if not exists email_type text;
alter table public.email_activity_log add column if not exists recipient text;
alter table public.email_activity_log add column if not exists sent_at timestamptz default timezone('utc', now());
alter table public.email_activity_log add column if not exists success boolean default false;
alter table public.email_activity_log add column if not exists failure_reason text;
alter table public.email_activity_log add column if not exists duration_ms integer default 0;
alter table public.email_activity_log add column if not exists trigger_type text;
alter table public.email_activity_log add column if not exists created_at timestamptz default timezone('utc', now());

create index if not exists email_activity_log_sent_at_idx on public.email_activity_log(sent_at desc);
create index if not exists email_activity_log_type_idx on public.email_activity_log(email_type, sent_at desc);

insert into public.email_settings (id, daily_brief_enabled, weekly_summary_enabled, recipient_email)
values ('99999999-9999-4999-8999-999999999999', false, false, 'Andrew.Walker@bluestonex.com')
on conflict (id) do nothing;

-- Temporary development access, consistent with the existing unauthenticated MVP.
-- Replace this with authenticated RLS policies before exposing production data publicly.
alter table public.email_settings disable row level security;
alter table public.email_activity_log disable row level security;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.email_settings to anon, authenticated;
grant select, insert, update, delete on table public.email_activity_log to anon, authenticated;
