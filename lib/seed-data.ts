import type {
  ActionItem,
  ActivityLog,
  Decision,
  Dependency,
  DocumentRecord,
  Meeting,
  Project,
  Requirement,
  Risk,
  TestCase,
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
    description:
      "Control centre for the Replenishment workstream changes needed to support delivery date range selection.",
    created_at: now,
    updated_at: now,
  },
];

export const requirements: Requirement[] = [
  ["REP-001", "Support Delivery Date Range selection in Replenishment Dashboard", "High", "In Progress"],
  ["REP-002", "Update ReleasedNotReleasedView for date range filtering", "High", "Open"],
  ["REP-003", "Update InProgressView for date range filtering", "High", "Open"],
  ["REP-004", "Update SalesOrderDetails for date range filtering", "Medium", "Open"],
  ["REP-005", "Update DeliveryDetailsView for date range filtering", "Medium", "Open"],
  ["REP-006", "Update _createTransferRequirement(req) to process multiple delivery dates", "Critical", "Open"],
  ["REP-007", "Validate replenishment demand aggregation logic", "Critical", "Open"],
  ["REP-008", "Validate load balancing after date range implementation", "High", "Pending"],
  ["REP-009", "Confirm maximum allowed delivery date range", "High", "Pending"],
  ["REP-010", "Confirm whether demand remains date-specific or aggregates across dates", "Critical", "Pending"],
].map(([requirement_ref, title, priority, status], index) => ({
  id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  requirement_ref,
  title,
  description: title,
  priority: priority as Requirement["priority"],
  status: status as Requirement["status"],
  owner: index < 6 ? "Development Team" : "Andrew Walker",
  source: "CR028 Replenishment discovery",
  notes: index > 7 ? "Needs Sysco confirmation before build sign-off." : "",
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
  created_at: now,
  updated_at: now,
}));

export const decisions: Decision[] = [
  ["DEC-001", "Should demand be aggregated across selected delivery dates?", "Pending"],
  ["DEC-002", "What is the maximum allowed delivery date range?", "Pending"],
  ["DEC-003", "Should replenishment tasks remain separated by delivery date?", "Open"],
  ["DEC-004", "What performance benchmark must be met before release?", "Open"],
].map(([decision_ref, question, status], index) => ({
  id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
  project_id: projectId,
  decision_ref,
  question,
  decision: "",
  owner: index < 2 ? "Sysco" : "Project Team",
  status: status as Decision["status"],
  decision_date: null,
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

export const seedData = {
  projects,
  requirements,
  risks,
  decisions,
  actions,
  dependencies,
  test_cases,
  meetings,
  documents,
  activity_log,
};
