-- Development-mode visibility and CR028 timeline ownership repair.
-- Authentication/RLS is not implemented yet, so timeline CRUD must remain available to the anon client.
-- Replace this grant/RLS setup when authentication is introduced.

alter table if exists public.timeline_items disable row level security;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.timeline_items to anon, authenticated;

do $$
declare
  canonical_project_id uuid;
begin
  select p.id
  into canonical_project_id
  from public.projects p
  where lower(trim(p.name)) = lower('CR028 - Delivery Date Range')
  order by (
    (select count(*) from public.requirements r where r.project_id = p.id) +
    (select count(*) from public.risks r where r.project_id = p.id) +
    (select count(*) from public.decisions d where d.project_id = p.id) +
    (select count(*) from public.actions a where a.project_id = p.id) +
    (select count(*) from public.discovery_questions q where q.project_id = p.id) +
    (select count(*) from public.milestones m where m.project_id = p.id) +
    (select count(*) from public.test_cases t where t.project_id = p.id)
  ) desc,
  p.created_at asc,
  p.id asc
  limit 1;

  if canonical_project_id is not null then
    update public.timeline_items item
    set project_id = canonical_project_id
    where item.project_id <> canonical_project_id
      and item.id in (
        select distinct on (candidate.phase_ref) candidate.id
        from public.timeline_items candidate
        join public.projects duplicate_project on duplicate_project.id = candidate.project_id
        where candidate.project_id <> canonical_project_id
          and lower(trim(duplicate_project.name)) = lower('CR028 - Delivery Date Range')
        order by candidate.phase_ref, candidate.created_at asc, candidate.id asc
      )
      and exists (
        select 1
        from public.projects duplicate_project
        where duplicate_project.id = item.project_id
          and lower(trim(duplicate_project.name)) = lower('CR028 - Delivery Date Range')
      )
      and not exists (
        select 1
        from public.timeline_items canonical_item
        where canonical_item.project_id = canonical_project_id
          and canonical_item.phase_ref = item.phase_ref
      );
  end if;
end $$;
