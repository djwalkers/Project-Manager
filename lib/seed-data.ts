import type {
  AcceptanceCriteria,
  ActionItem,
  ActivityLog,
  Decision,
  Deliverable,
  Dependency,
  DiscoveryQuestion,
  DocumentRecord,
  Meeting,
  Milestone,
  Project,
  Requirement,
  Risk,
  TestCase,
  TimelineItem,
  ProjectSnapshot,
  EmailSettings,
  EmailActivity,
} from "@/lib/types";

export const projectId = "11111111-1111-4111-8111-111111111111";
const now = "2026-06-22T09:00:00.000Z";

export const projects: Project[] = [
  {
    id: projectId,
    name: "CR028 - Delivery Date Range",
    customer: "Sysco",
    workstream: "Replenishment",
    status: "Discovery",
    health: "Amber",
    schedule_variance: -4,
    planned_start_date: "2026-06-22",
    planned_end_date: "2026-07-24",
    description:
      "Control centre for the Replenishment workstream changes needed to support delivery date range selection.",
    created_at: now,
    updated_at: now,
  },
];

export const requirements: Requirement[] = [
  ["REP-001", "Support Delivery Date Range selection in Replenishment Dashboard", "High", "UI", "In Progress"],
  ["REP-002", "Update ReleasedNotReleasedView for date range filtering", "High", "UI", "Open"],
  ["REP-003", "Update InProgressView for date range filtering", "High", "UI", "Open"],
  ["REP-004", "Update SalesOrderDetails for date range filtering", "Medium", "UI", "Open"],
  ["REP-005", "Update DeliveryDetailsView for date range filtering", "Medium", "UI", "Open"],
  ["REP-006", "Update _createTransferRequirement(req) to process multiple delivery dates", "Critical", "Backend", "Open"],
  ["REP-007", "Validate replenishment demand aggregation logic", "Critical", "Business Rule", "Open"],
  ["REP-008", "Validate load balancing after date range implementation", "High", "Testing", "Pending"],
  ["REP-009", "Confirm maximum allowed delivery date range", "High", "Business Rule", "Pending"],
  ["REP-010", "Confirm whether demand remains date-specific or aggregates across dates", "Critical", "Business Rule", "Pending"],
].map(([requirement_ref, title, priority, category, status], index) => ({
  id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  requirement_ref,
  title,
  description: title,
  priority: priority as Requirement["priority"],
  category: category as Requirement["category"],
  status: status as Requirement["status"],
  owner: index < 6 ? "Development Team" : "Andrew Walker",
  source: "CR028 Replenishment discovery",
  notes: index > 7 ? "Needs Sysco confirmation before build sign-off." : "",
  created_at: now,
  updated_at: now,
}));

export const deliverables: Deliverable[] = [
  ["DEL-001", "ReleasedNotReleasedView", "UI / Development", "Development Team", "High", "In Analysis", "2026-06-30"],
  ["DEL-002", "InProgressView", "UI / Development", "Development Team", "High", "In Analysis", "2026-06-30"],
  ["DEL-003", "SalesOrderDetails", "UI / Development", "Development Team", "Medium", "Not Started", "2026-07-03"],
  ["DEL-004", "DeliveryDetailsView", "UI / Development", "Development Team", "Medium", "Not Started", "2026-07-03"],
  ["DEL-005", "_createTransferRequirement()", "Backend", "Development Team", "Critical", "In Analysis", "2026-07-10"],
  ["DEL-006", "Replenishment Rules", "Business Rules", "Andrew Walker", "Critical", "In Analysis", "2026-07-08"],
  ["DEL-007", "Load Balancing Validation", "Performance", "Solution Architect", "High", "Not Started", "2026-07-14"],
  ["DEL-008", "SIT Execution", "Testing", "QA Lead", "High", "Not Started", "2026-07-17"],
  ["DEL-009", "UAT Sign-off", "Testing", "Sysco", "High", "Not Started", "2026-07-24"],
].map(([deliverable_ref, title, workstream, owner, priority, status, planned_completion_date], index) => ({
  id: `f0f0f0f0-f0f0-4f0f-8f0f-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  deliverable_ref,
  title,
  description: `${title} delivery scope for CR028 Replenishment.`,
  workstream,
  owner,
  priority: priority as Deliverable["priority"],
  status: status as Deliverable["status"],
  planned_completion_date,
  actual_completion_date: null,
  development_status: status === "In Analysis" ? "In Analysis" : "Not Started",
  sit_status: "Not Started",
  uat_status: "Not Started",
  deployment_status: "Not Started",
  notes: "Tracked through development, SIT, UAT and deployment readiness.",
  created_at: now,
  updated_at: now,
}));

export const risks: Risk[] = [
  ["RISK-001", "Over-replenishment caused by incorrect aggregation across delivery dates", "Critical", "Medium"],
  ["RISK-002", "Under-replenishment caused by future demand being missed", "High", "Medium"],
  ["RISK-003", "Performance degradation caused by larger date range data volumes", "High", "High"],
  ["RISK-004", "User selects an excessive date range and triggers unintended processing", "Medium", "High"],
  ["RISK-005", "Load balancing issues in _createTransferRequirement(req)", "High", "Medium"],
].map(([risk_ref, description, impact, probability], index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  risk_ref,
  description,
  impact: impact as Risk["impact"],
  probability: probability as Risk["probability"],
  mitigation: "Validate behaviour in focused replenishment test scenarios before release approval.",
  owner: index === 2 ? "Solution Architect" : "Andrew Walker",
  status: index === 0 || index === 2 ? "Open" : "In Progress",
  trend: null,
  created_at: now,
  updated_at: now,
}));

export const decisions: Decision[] = [
  ["DEC-001", "Should demand be aggregated across selected delivery dates?", "Pending", "2026-06-25"],
  ["DEC-002", "What is the maximum allowed delivery date range?", "Pending", "2026-06-26"],
  ["DEC-003", "Should replenishment tasks remain separated by delivery date?", "Open", "2026-06-27"],
  ["DEC-004", "What performance benchmark must be met before release?", "Open", "2026-06-30"],
].map(([decision_ref, question, status, due_date], index) => ({
  id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  decision_ref,
  question,
  decision: "",
  owner: index < 2 ? "Sysco" : "Project Team",
  status: status as Decision["status"],
  decision_date: null,
  due_date,
  created_at: now,
  updated_at: now,
}));

export const actions: ActionItem[] = [
  ["ACT-001", "Confirm current replenishment demand calculation with development team", "Development Team", "2026-06-24", "Open"],
  ["ACT-002", "Confirm business rule for multi-date demand aggregation with Sysco", "Sysco", "2026-06-25", "Open"],
  ["ACT-003", "Identify current average replenishment job execution time", "Solution Architect", "2026-06-23", "In Progress"],
  ["ACT-004", "Agree maximum date range validation rule", "Andrew Walker", "2026-06-27", "Pending"],
  ["ACT-005", "Prepare replenishment test scenarios", "QA Lead", "2026-06-26", "Open"],
].map(([action_ref, description, owner, due_date, status], index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  action_ref,
  description,
  owner,
  due_date,
  status: status as ActionItem["status"],
  notes: "",
  created_at: now,
  updated_at: now,
}));

export const dependencies: Dependency[] = [
  "ReleasedNotReleasedView",
  "InProgressView",
  "SalesOrderDetails",
  "DeliveryDetailsView",
  "_createTransferRequirement(req)",
  "Replen Rule Updates",
  "Load Balancing Logic",
  "Supabase Schema",
].map((name, index) => ({
  id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  name,
  owner: index < 5 ? "Development Team" : "Project Team",
  status: index === 7 ? "Complete" : "Open",
  notes: "Tracked for CR028 Replenishment delivery date range readiness.",
  created_at: now,
  updated_at: now,
}));

export const test_cases: TestCase[] = [
  ["TEST-001", "Single delivery date behaves as current process"],
  ["TEST-002", "Two delivery dates calculate replenishment demand correctly"],
  ["TEST-003", "Three delivery dates calculate replenishment demand correctly"],
  ["TEST-004", "Same route across multiple delivery dates remains logically separated"],
  ["TEST-005", "Excessive date range is blocked or warned"],
  ["TEST-006", "Large data volume completes within agreed benchmark"],
].map(([test_ref, scenario], index) => ({
  id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  test_ref,
  scenario,
  expected_result: "Expected result to be confirmed during discovery.",
  actual_result: "",
  status: index === 0 ? "In Progress" : "Pending",
  owner: "QA Lead",
  created_at: now,
  updated_at: now,
}));

export const meetings: Meeting[] = [
  {
    id: "88888888-8888-4888-8888-000000000001",
    project_id: projectId,
    meeting_date: "2026-06-23",
    title: "CR028 Replenishment discovery sync",
    attendees: "Andrew Walker, Sysco, Development Team",
    notes: "Confirm demand aggregation, validation rules and performance baseline.",
    decisions: "",
    actions: "Review ACT-001 to ACT-005",
    created_at: now,
    updated_at: now,
  },
];

export const documents: DocumentRecord[] = [
  {
    id: "99999999-9999-4999-8999-000000000001",
    project_id: projectId,
    document_name: "CR028 Replenishment Notes",
    document_type: "Discovery",
    storage_path: "",
    notes: "Document upload will be added in v2.",
    uploaded_at: now,
  },
];

export const activity_log: ActivityLog[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    project_id: projectId,
    activity_type: "Project created",
    description: "CR028 Replenishment control centre initialized.",
    created_at: now,
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
    project_id: projectId,
    activity_type: "Discovery",
    description: "Initial requirements, risks, decisions and test cases captured.",
    created_at: now,
  },
];

export const discovery_questions: DiscoveryQuestion[] = [
  ["Q001", "Should replenishment demand aggregate across selected delivery dates?", "Sysco", "Business Rule", "Awaiting Business", "2026-06-25"],
  ["Q002", "What is the maximum allowed delivery date range?", "Sysco", "Business Rule", "Awaiting Business", "2026-06-26"],
  ["Q003", "Should replenishment tasks remain separated by delivery date?", "Development Team", "Replenishment Logic", "Awaiting Development", "2026-06-25"],
  ["Q004", "What are the current replenishment job execution times?", "Solution Architect", "Performance", "Awaiting Development", "2026-06-24"],
  ["Q005", "Are there existing load balancing issues in _createTransferRequirement(req)?", "Development Team", "Replenishment Logic", "Awaiting Development", "2026-06-24"],
  ["Q006", "What is the business acceptance criteria for replenishment accuracy?", "Sysco", "Testing", "Awaiting Business", "2026-06-27"],
].map(([question_ref, question, owner, category, status, due_date], index) => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  question_ref,
  question,
  owner,
  category: category as DiscoveryQuestion["category"],
  status: status as DiscoveryQuestion["status"],
  due_date,
  answer: "",
  notes: "",
  raised_to: null,
  raised_date: null,
  response: null,
  answered_by: null,
  answered_date: null,
  created_at: now,
  updated_at: now,
}));

export const milestones: Milestone[] = [
  ["M001", "Discovery Complete", "2026-06-30", "In Progress", "Andrew Walker"],
  ["M002", "Requirements Sign-off", "2026-07-02", "Not Started", "Andrew Walker"],
  ["M003", "Development Start", "2026-07-06", "Not Started", "Development Team"],
  ["M004", "SIT Complete", "2026-07-17", "Not Started", "QA Lead"],
  ["M005", "UAT Complete", "2026-07-24", "Not Started", "Sysco"],
  ["M006", "Go Live", "2026-08-03", "Not Started", "Project Team"],
].map(([milestone_ref, title, target_date, status, owner], index) => ({
  id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  milestone_ref,
  title,
  target_date,
  status: status as Milestone["status"],
  owner,
  notes: "",
  created_at: now,
  updated_at: now,
}));

export const timeline_items: TimelineItem[] = [
  ["PH-001", "Functional Analysis", "2026-06-22", "2026-06-25", "Andy", "In Progress", 25],
  ["PH-002", "UI Design", "2026-06-24", "2026-06-30", "UI / Development", "Not Started", 0],
  ["PH-003", "Replenishment Development", "2026-06-29", "2026-07-15", "Development", "Not Started", 0],
  ["PH-004", "Picking/Palletisation/Marshalling/Loading Development", "2026-06-29", "2026-07-17", "Development", "Not Started", 0],
  ["PH-005", "UI Development", "2026-07-01", "2026-07-10", "UI / Development", "Not Started", 0],
  ["PH-006", "Unit Testing Picking/Palletisation/Marshalling/Loading/Replen", "2026-07-16", "2026-07-24", "Testing / Andy", "Not Started", 0],
].map(([phase_ref, phase_name, start_date, end_date, owner, status, progress_percent], index) => ({
  id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  phase_ref: String(phase_ref),
  phase_name: String(phase_name),
  start_date: String(start_date),
  end_date: String(end_date),
  owner: String(owner),
  status: status as TimelineItem["status"],
  progress_percent: Number(progress_percent),
  notes: "",
  created_at: now,
  updated_at: now,
}));

export const project_snapshots: ProjectSnapshot[] = [
  {
    id: "eeeeeeee-eeee-4eee-8eee-000000000001",
    project_id: projectId,
    snapshot_date: "2026-06-23",
    project_health: "Amber",
    schedule_health: "Amber",
    progress_percent: 0,
    schedule_variance: -4.6,
    open_risks: 5,
    open_actions: 5,
    overdue_actions: 0,
    open_decisions: 4,
    overdue_decisions: 0,
    open_questions: 6,
    active_milestone: "Discovery Complete",
    active_phase: "Functional Analysis",
    created_at: "2026-06-23T17:00:00.000Z",
  },
];

export const email_settings: EmailSettings[] = [{
  id: "99999999-9999-4999-8999-999999999999",
  daily_brief_enabled: false,
  weekly_summary_enabled: false,
  manager_summary_enabled: false,
  recipient_email: "Andrew.Walker@bluestonex.com",
  manager_recipient_email: null,
  created_at: now,
  updated_at: now,
}];

export const email_activity_log: EmailActivity[] = [];

export const go_live_checklists: import("@/lib/types").GoLiveChecklist[] = [];
export const cutover_plan: import("@/lib/types").CutoverStep[] = [];

export const seedData = {
  projects,
  deliverables,
  requirements,
  risks,
  decisions,
  actions,
  dependencies,
  test_cases,
  meetings,
  documents,
  activity_log,
  discovery_questions,
  milestones,
  timeline_items,
  project_snapshots,
  email_settings,
  email_activity_log,
  go_live_checklists,
  cutover_plan,
  acceptance_criteria: [] as AcceptanceCriteria[],
};
