-- Full, idempotent CR028 seed for the aligned schema.
-- Run migrations through 005_project_snapshots.sql before this file.

begin;

insert into public.projects (id, name, customer, workstream, status, health, schedule_variance, planned_start_date, planned_end_date, description)
values (
  '11111111-1111-4111-8111-111111111111',
  'CR028 - Delivery Date Range',
  'Sysco',
  'Replenishment',
  'Discovery',
  'Amber',
  -4,
  '2026-06-22',
  '2026-07-24',
  'Control centre for the Replenishment workstream changes needed to support delivery date range selection.'
)
on conflict (name) do update set
  customer = excluded.customer,
  workstream = excluded.workstream,
  status = excluded.status,
  health = excluded.health,
  schedule_variance = excluded.schedule_variance,
  planned_start_date = excluded.planned_start_date,
  planned_end_date = excluded.planned_end_date,
  description = excluded.description;

insert into public.requirements (project_id, requirement_ref, title, description, priority, category, status, owner, source, notes)
values
('11111111-1111-4111-8111-111111111111', 'REP-001', 'Support Delivery Date Range selection in Replenishment Dashboard', 'Support Delivery Date Range selection in Replenishment Dashboard', 'High', 'UI', 'In Progress', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-002', 'Update ReleasedNotReleasedView for date range filtering', 'Update ReleasedNotReleasedView for date range filtering', 'High', 'UI', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-003', 'Update InProgressView for date range filtering', 'Update InProgressView for date range filtering', 'High', 'UI', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-004', 'Update SalesOrderDetails for date range filtering', 'Update SalesOrderDetails for date range filtering', 'Medium', 'UI', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-005', 'Update DeliveryDetailsView for date range filtering', 'Update DeliveryDetailsView for date range filtering', 'Medium', 'UI', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-006', 'Update _createTransferRequirement(req) to process multiple delivery dates', 'Update _createTransferRequirement(req) to process multiple delivery dates', 'Critical', 'Backend', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-007', 'Validate replenishment demand aggregation logic', 'Validate replenishment demand aggregation logic', 'Critical', 'Business Rule', 'Open', 'Andrew Walker', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-008', 'Validate load balancing after date range implementation', 'Validate load balancing after date range implementation', 'High', 'Testing', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-009', 'Confirm maximum allowed delivery date range', 'Confirm maximum allowed delivery date range', 'High', 'Business Rule', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', 'Needs Sysco confirmation before build sign-off.'),
('11111111-1111-4111-8111-111111111111', 'REP-010', 'Confirm whether demand remains date-specific or aggregates across dates', 'Confirm whether demand remains date-specific or aggregates across dates', 'Critical', 'Business Rule', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', 'Needs Sysco confirmation before build sign-off.')
on conflict (project_id, requirement_ref) do update set
  title = excluded.title, description = excluded.description, priority = excluded.priority,
  category = excluded.category, status = excluded.status, owner = excluded.owner,
  source = excluded.source, notes = excluded.notes;

insert into public.risks (project_id, risk_ref, description, impact, probability, mitigation, owner, status)
values
('11111111-1111-4111-8111-111111111111', 'RISK-001', 'Over-replenishment caused by incorrect aggregation across delivery dates', 'Critical', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'Open'),
('11111111-1111-4111-8111-111111111111', 'RISK-002', 'Under-replenishment caused by future demand being missed', 'High', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress'),
('11111111-1111-4111-8111-111111111111', 'RISK-003', 'Performance degradation caused by larger date range data volumes', 'High', 'High', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Solution Architect', 'Open'),
('11111111-1111-4111-8111-111111111111', 'RISK-004', 'User selects an excessive date range and triggers unintended processing', 'Medium', 'High', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress'),
('11111111-1111-4111-8111-111111111111', 'RISK-005', 'Load balancing issues in _createTransferRequirement(req)', 'High', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress')
on conflict (project_id, risk_ref) do update set
  description = excluded.description, impact = excluded.impact, probability = excluded.probability,
  mitigation = excluded.mitigation, owner = excluded.owner, status = excluded.status;

insert into public.decisions (project_id, decision_ref, question, decision, owner, status, decision_date, due_date)
values
('11111111-1111-4111-8111-111111111111', 'DEC-001', 'Should demand be aggregated across selected delivery dates?', '', 'Sysco', 'Pending', null, '2026-06-25'),
('11111111-1111-4111-8111-111111111111', 'DEC-002', 'What is the maximum allowed delivery date range?', '', 'Sysco', 'Pending', null, '2026-06-26'),
('11111111-1111-4111-8111-111111111111', 'DEC-003', 'Should replenishment tasks remain separated by delivery date?', '', 'Project Team', 'Open', null, '2026-06-27'),
('11111111-1111-4111-8111-111111111111', 'DEC-004', 'What performance benchmark must be met before release?', '', 'Project Team', 'Open', null, '2026-06-30')
on conflict (project_id, decision_ref) do update set
  question = excluded.question, decision = excluded.decision, owner = excluded.owner,
  status = excluded.status, decision_date = excluded.decision_date, due_date = excluded.due_date;

insert into public.discovery_questions (project_id, question_ref, question, owner, category, status, due_date, answer, notes)
values
('11111111-1111-4111-8111-111111111111', 'Q001', 'Should replenishment demand aggregate across selected delivery dates?', 'Sysco', 'Business Rule', 'Awaiting Business', '2026-06-25', '', ''),
('11111111-1111-4111-8111-111111111111', 'Q002', 'What is the maximum allowed delivery date range?', 'Sysco', 'Business Rule', 'Awaiting Business', '2026-06-26', '', ''),
('11111111-1111-4111-8111-111111111111', 'Q003', 'Should replenishment tasks remain separated by delivery date?', 'Development Team', 'Replenishment Logic', 'Awaiting Development', '2026-06-25', '', ''),
('11111111-1111-4111-8111-111111111111', 'Q004', 'What are the current replenishment job execution times?', 'Solution Architect', 'Performance', 'Awaiting Development', '2026-06-24', '', ''),
('11111111-1111-4111-8111-111111111111', 'Q005', 'Are there existing load balancing issues in _createTransferRequirement(req)?', 'Development Team', 'Replenishment Logic', 'Awaiting Development', '2026-06-24', '', ''),
('11111111-1111-4111-8111-111111111111', 'Q006', 'What is the business acceptance criteria for replenishment accuracy?', 'Sysco', 'Testing', 'Awaiting Business', '2026-06-27', '', '')
on conflict (project_id, question_ref) do update set
  question = excluded.question, owner = excluded.owner, category = excluded.category,
  status = excluded.status, due_date = excluded.due_date, answer = excluded.answer, notes = excluded.notes;

insert into public.actions (project_id, action_ref, description, owner, due_date, status, notes)
values
('11111111-1111-4111-8111-111111111111', 'ACT-001', 'Confirm current replenishment demand calculation with development team', 'Development Team', '2026-06-24', 'Open', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-002', 'Confirm business rule for multi-date demand aggregation with Sysco', 'Sysco', '2026-06-25', 'Open', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-003', 'Identify current average replenishment job execution time', 'Solution Architect', '2026-06-23', 'In Progress', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-004', 'Agree maximum date range validation rule', 'Andrew Walker', '2026-06-27', 'Pending', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-005', 'Prepare replenishment test scenarios', 'QA Lead', '2026-06-26', 'Open', '')
on conflict (project_id, action_ref) do update set
  description = excluded.description, owner = excluded.owner, due_date = excluded.due_date,
  status = excluded.status, notes = excluded.notes;

insert into public.dependencies (project_id, name, owner, status, notes)
values
('11111111-1111-4111-8111-111111111111', 'ReleasedNotReleasedView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'InProgressView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'SalesOrderDetails', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'DeliveryDetailsView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', '_createTransferRequirement(req)', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Replen Rule Updates', 'Project Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Load Balancing Logic', 'Project Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Supabase Schema', 'Project Team', 'Complete', 'Tracked for CR028 Replenishment delivery date range readiness.')
on conflict (project_id, name) do update set
  owner = excluded.owner, status = excluded.status, notes = excluded.notes;

insert into public.milestones (project_id, milestone_ref, title, target_date, status, owner, notes)
values
('11111111-1111-4111-8111-111111111111', 'M001', 'Discovery Complete', '2026-06-30', 'In Progress', 'Andrew Walker', ''),
('11111111-1111-4111-8111-111111111111', 'M002', 'Requirements Sign-off', '2026-07-02', 'Not Started', 'Andrew Walker', ''),
('11111111-1111-4111-8111-111111111111', 'M003', 'Development Start', '2026-07-06', 'Not Started', 'Development Team', ''),
('11111111-1111-4111-8111-111111111111', 'M004', 'SIT Complete', '2026-07-17', 'Not Started', 'QA Lead', ''),
('11111111-1111-4111-8111-111111111111', 'M005', 'UAT Complete', '2026-07-24', 'Not Started', 'Sysco', ''),
('11111111-1111-4111-8111-111111111111', 'M006', 'Go Live', '2026-08-03', 'Not Started', 'Project Team', '')
on conflict (project_id, milestone_ref) do update set
  title = excluded.title, target_date = excluded.target_date,
  status = excluded.status, owner = excluded.owner, notes = excluded.notes;

insert into public.test_cases (project_id, test_ref, scenario, expected_result, actual_result, status, owner)
values
('11111111-1111-4111-8111-111111111111', 'TEST-001', 'Single delivery date behaves as current process', 'Expected result to be confirmed during discovery.', '', 'In Progress', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-002', 'Two delivery dates calculate replenishment demand correctly', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-003', 'Three delivery dates calculate replenishment demand correctly', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-004', 'Same route across multiple delivery dates remains logically separated', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-005', 'Excessive date range is blocked or warned', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-006', 'Large data volume completes within agreed benchmark', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead')
on conflict (project_id, test_ref) do update set
  scenario = excluded.scenario, expected_result = excluded.expected_result,
  actual_result = excluded.actual_result, status = excluded.status, owner = excluded.owner;

insert into public.timeline_items (project_id, phase_ref, phase_name, start_date, end_date, owner, status, progress_percent, notes)
values
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-001', 'Functional Analysis', '2026-06-22', '2026-06-25', 'Andy', 'In Progress', 25, ''),
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-002', 'UI Design', '2026-06-24', '2026-06-30', 'UI / Development', 'Not Started', 0, ''),
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-003', 'Replenishment Development', '2026-06-29', '2026-07-15', 'Development', 'Not Started', 0, ''),
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-004', 'Picking/Palletisation/Marshalling/Loading Development', '2026-06-29', '2026-07-17', 'Development', 'Not Started', 0, ''),
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-005', 'UI Development', '2026-07-01', '2026-07-10', 'UI / Development', 'Not Started', 0, ''),
((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), 'PH-006', 'Unit Testing Picking/Palletisation/Marshalling/Loading/Replen', '2026-07-16', '2026-07-24', 'Testing / Andy', 'Not Started', 0, '')
on conflict (project_id, phase_ref) do update set
  phase_name = excluded.phase_name, start_date = excluded.start_date, end_date = excluded.end_date,
  owner = excluded.owner, status = excluded.status, progress_percent = excluded.progress_percent, notes = excluded.notes;

insert into public.project_snapshots (project_id, snapshot_date, project_health, schedule_health, progress_percent, schedule_variance, open_risks, open_actions, overdue_actions, open_decisions, overdue_decisions, open_questions, active_milestone, active_phase)
values ((select id from public.projects where name = 'CR028 - Delivery Date Range' order by created_at asc limit 1), '2026-06-23', 'Amber', 'Amber', 0, -4.6, 5, 5, 0, 4, 0, 6, 'Discovery Complete', 'Functional Analysis')
on conflict (project_id, snapshot_date) do update set
  project_health = excluded.project_health, schedule_health = excluded.schedule_health,
  progress_percent = excluded.progress_percent, schedule_variance = excluded.schedule_variance,
  open_risks = excluded.open_risks, open_actions = excluded.open_actions,
  overdue_actions = excluded.overdue_actions, open_decisions = excluded.open_decisions,
  overdue_decisions = excluded.overdue_decisions, open_questions = excluded.open_questions,
  active_milestone = excluded.active_milestone, active_phase = excluded.active_phase;

commit;
