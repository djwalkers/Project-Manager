insert into public.projects (id, name, customer, workstream, status, description)
values (
  '11111111-1111-4111-8111-111111111111',
  'CR028 - Delivery Date Range',
  'Sysco',
  'Replenishment',
  'Discovery',
  'Control centre for the Replenishment workstream changes needed to support delivery date range selection.'
)
on conflict (id) do update set
  name = excluded.name,
  customer = excluded.customer,
  workstream = excluded.workstream,
  status = excluded.status,
  description = excluded.description;

insert into public.requirements (project_id, requirement_ref, title, description, priority, status, owner, source, notes)
values
('11111111-1111-4111-8111-111111111111', 'REP-001', 'Support Delivery Date Range selection in Replenishment Dashboard', 'Support Delivery Date Range selection in Replenishment Dashboard', 'High', 'In Progress', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-002', 'Update ReleasedNotReleasedView for date range filtering', 'Update ReleasedNotReleasedView for date range filtering', 'High', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-003', 'Update InProgressView for date range filtering', 'Update InProgressView for date range filtering', 'High', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-004', 'Update SalesOrderDetails for date range filtering', 'Update SalesOrderDetails for date range filtering', 'Medium', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-005', 'Update DeliveryDetailsView for date range filtering', 'Update DeliveryDetailsView for date range filtering', 'Medium', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-006', 'Update _createTransferRequirement(req) to process multiple delivery dates', 'Update _createTransferRequirement(req) to process multiple delivery dates', 'Critical', 'Open', 'Development Team', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-007', 'Validate replenishment demand aggregation logic', 'Validate replenishment demand aggregation logic', 'Critical', 'Open', 'Andrew Walker', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-008', 'Validate load balancing after date range implementation', 'Validate load balancing after date range implementation', 'High', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', ''),
('11111111-1111-4111-8111-111111111111', 'REP-009', 'Confirm maximum allowed delivery date range', 'Confirm maximum allowed delivery date range', 'High', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', 'Needs Sysco confirmation before build sign-off.'),
('11111111-1111-4111-8111-111111111111', 'REP-010', 'Confirm whether demand remains date-specific or aggregates across dates', 'Confirm whether demand remains date-specific or aggregates across dates', 'Critical', 'Pending', 'Andrew Walker', 'CR028 Replenishment discovery', 'Needs Sysco confirmation before build sign-off.');

insert into public.risks (project_id, risk_ref, description, impact, probability, mitigation, owner, status)
values
('11111111-1111-4111-8111-111111111111', 'RISK-001', 'Over-replenishment caused by incorrect aggregation across delivery dates', 'Critical', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'Open'),
('11111111-1111-4111-8111-111111111111', 'RISK-002', 'Under-replenishment caused by future demand being missed', 'High', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress'),
('11111111-1111-4111-8111-111111111111', 'RISK-003', 'Performance degradation caused by larger date range data volumes', 'High', 'High', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Solution Architect', 'Open'),
('11111111-1111-4111-8111-111111111111', 'RISK-004', 'User selects an excessive date range and triggers unintended processing', 'Medium', 'High', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress'),
('11111111-1111-4111-8111-111111111111', 'RISK-005', 'Load balancing issues in _createTransferRequirement(req)', 'High', 'Medium', 'Validate behaviour in focused replenishment test scenarios before release approval.', 'Andrew Walker', 'In Progress');

insert into public.decisions (project_id, decision_ref, question, decision, owner, status, decision_date)
values
('11111111-1111-4111-8111-111111111111', 'DEC-001', 'Should demand be aggregated across selected delivery dates?', '', 'Sysco', 'Pending', null),
('11111111-1111-4111-8111-111111111111', 'DEC-002', 'What is the maximum allowed delivery date range?', '', 'Sysco', 'Pending', null),
('11111111-1111-4111-8111-111111111111', 'DEC-003', 'Should replenishment tasks remain separated by delivery date?', '', 'Project Team', 'Open', null),
('11111111-1111-4111-8111-111111111111', 'DEC-004', 'What performance benchmark must be met before release?', '', 'Project Team', 'Open', null);

insert into public.actions (project_id, action_ref, description, owner, due_date, status, notes)
values
('11111111-1111-4111-8111-111111111111', 'ACT-001', 'Confirm current replenishment demand calculation with development team', 'Development Team', '2026-06-24', 'Open', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-002', 'Confirm business rule for multi-date demand aggregation with Sysco', 'Sysco', '2026-06-25', 'Open', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-003', 'Identify current average replenishment job execution time', 'Solution Architect', '2026-06-23', 'In Progress', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-004', 'Agree maximum date range validation rule', 'Andrew Walker', '2026-06-27', 'Pending', ''),
('11111111-1111-4111-8111-111111111111', 'ACT-005', 'Prepare replenishment test scenarios', 'QA Lead', '2026-06-26', 'Open', '');

insert into public.dependencies (project_id, name, owner, status, notes)
values
('11111111-1111-4111-8111-111111111111', 'ReleasedNotReleasedView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'InProgressView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'SalesOrderDetails', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'DeliveryDetailsView', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', '_createTransferRequirement(req)', 'Development Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Replen Rule Updates', 'Project Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Load Balancing Logic', 'Project Team', 'Open', 'Tracked for CR028 Replenishment delivery date range readiness.'),
('11111111-1111-4111-8111-111111111111', 'Supabase Schema', 'Project Team', 'Complete', 'Tracked for CR028 Replenishment delivery date range readiness.');

insert into public.test_cases (project_id, test_ref, scenario, expected_result, actual_result, status, owner)
values
('11111111-1111-4111-8111-111111111111', 'TEST-001', 'Single delivery date behaves as current process', 'Expected result to be confirmed during discovery.', '', 'In Progress', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-002', 'Two delivery dates calculate replenishment demand correctly', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-003', 'Three delivery dates calculate replenishment demand correctly', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-004', 'Same route across multiple delivery dates remains logically separated', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-005', 'Excessive date range is blocked or warned', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead'),
('11111111-1111-4111-8111-111111111111', 'TEST-006', 'Large data volume completes within agreed benchmark', 'Expected result to be confirmed during discovery.', '', 'Pending', 'QA Lead');

insert into public.meetings (project_id, meeting_date, title, attendees, notes, decisions, actions)
values ('11111111-1111-4111-8111-111111111111', '2026-06-23', 'CR028 Replenishment discovery sync', 'Andrew Walker, Sysco, Development Team', 'Confirm demand aggregation, validation rules and performance baseline.', '', 'Review ACT-001 to ACT-005');

insert into public.documents (project_id, document_name, document_type, storage_path, notes)
values ('11111111-1111-4111-8111-111111111111', 'CR028 Replenishment Notes', 'Discovery', '', 'Document upload will be added in v2.');

insert into public.activity_log (project_id, activity_type, description)
values
('11111111-1111-4111-8111-111111111111', 'Project created', 'CR028 Replenishment control centre initialized.'),
('11111111-1111-4111-8111-111111111111', 'Discovery', 'Initial requirements, risks, decisions and test cases captured.');
