export type Status =
  | "Discovery"
  | "Open"
  | "In Progress"
  | "Pending"
  | "Blocked"
  | "Approved"
  | "Complete"
  | "Closed";

export type Priority = "Low" | "Medium" | "High" | "Critical";
export type Impact = "Low" | "Medium" | "High" | "Critical";
export type Probability = "Low" | "Medium" | "High";
export type ProjectHealth = "Green" | "Amber" | "Red";
export type RequirementCategory = "Business Rule" | "Database" | "Backend" | "UI" | "Performance" | "Testing";
export type TestStatus = "Pending" | "In Progress" | "Passed" | "Failed" | "Blocked";
export type DeliverableStatus = "Not Started" | "In Analysis" | "In Development" | "Ready for SIT" | "SIT Complete" | "Ready for UAT" | "UAT Complete" | "Ready for Deployment" | "Deployed" | "Blocked";

export type Project = {
  id: string;
  name: string;
  customer: string;
  workstream: string;
  status: Status;
  health: ProjectHealth;
  schedule_variance: number;
  planned_start_date: string | null;
  planned_end_date: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type TimelineStatus = "Not Started" | "In Progress" | "Complete" | "At Risk" | "Blocked";

export type TimelineItem = {
  id: string;
  project_id: string;
  phase_ref: string;
  phase_name: string;
  start_date: string;
  end_date: string;
  owner: string | null;
  status: TimelineStatus;
  progress_percent: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectSnapshot = {
  id: string;
  project_id: string;
  snapshot_date: string;
  project_health: ProjectHealth;
  schedule_health: ProjectHealth | "Review";
  progress_percent: number;
  schedule_variance: number;
  open_risks: number;
  open_actions: number;
  overdue_actions: number;
  open_decisions: number;
  overdue_decisions: number;
  open_questions: number;
  active_milestone: string | null;
  active_phase: string | null;
  created_at: string;
};

export type Deliverable = {
  id: string;
  project_id: string;
  deliverable_ref: string;
  title: string;
  description: string | null;
  workstream: string;
  owner: string | null;
  priority: Priority;
  status: DeliverableStatus;
  planned_completion_date: string | null;
  actual_completion_date: string | null;
  development_status: string;
  sit_status: string;
  uat_status: string;
  deployment_status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type GoLiveChecklistCategory =
  | "Requirements" | "Development" | "SIT" | "UAT" | "Data"
  | "Training" | "Deployment" | "Hypercare" | "Rollback" | "Support" | "Customer Approval";

export type GoLiveChecklistStatus = "Not Started" | "In Progress" | "Complete" | "Blocked" | "Waived";

export type GoLiveChecklist = {
  id: string;
  project_id: string;
  category: GoLiveChecklistCategory;
  item: string;
  owner: string | null;
  status: GoLiveChecklistStatus;
  due_date: string | null;
  completed_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type CutoverStepStatus = "Not Started" | "In Progress" | "Complete" | "Blocked" | "Skipped";

export type CutoverStep = {
  id: string;
  project_id: string;
  step_number: number;
  activity: string;
  owner: string | null;
  planned_time: string | null;
  actual_time: string | null;
  status: CutoverStepStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailSettings = {
  id: string;
  daily_brief_enabled: boolean;
  weekly_summary_enabled: boolean;
  manager_summary_enabled: boolean;
  recipient_email: string;
  manager_recipient_email: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailActivity = {
  id: string;
  email_type: "Test" | "Daily Brief" | "Weekly Summary" | "Manager Summary";
  recipient: string;
  sent_at: string;
  success: boolean;
  failure_reason: string | null;
  duration_ms: number;
  trigger_type: "Manual" | "Scheduled";
  created_at: string;
};

export type Requirement = {
  id: string;
  project_id: string;
  requirement_ref: string;
  title: string;
  description: string | null;
  priority: Priority;
  category: RequirementCategory;
  status: Status;
  owner: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Risk = {
  id: string;
  project_id: string;
  risk_ref: string;
  description: string;
  impact: Impact;
  probability: Probability;
  mitigation: string | null;
  owner: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
};

export type Decision = {
  id: string;
  project_id: string;
  decision_ref: string;
  question: string;
  decision: string | null;
  owner: string | null;
  status: Status;
  decision_date: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

export type ActionItem = {
  id: string;
  project_id: string;
  action_ref: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  status: Status;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Dependency = {
  id: string;
  project_id: string;
  name: string;
  owner: string | null;
  status: Status;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type TestCase = {
  id: string;
  project_id: string;
  test_ref: string;
  scenario: string;
  expected_result: string | null;
  actual_result: string | null;
  status: TestStatus;
  owner: string | null;
  created_at: string;
  updated_at: string;
};

export type Meeting = {
  id: string;
  project_id: string;
  meeting_date: string;
  title: string;
  attendees: string | null;
  notes: string | null;
  decisions: string | null;
  actions: string | null;
  created_at: string;
  updated_at: string;
};

export type DocumentRecord = {
  id: string;
  project_id: string;
  document_name: string;
  document_type: string | null;
  storage_path: string | null;
  notes: string | null;
  uploaded_at: string;
};

export type ActivityLog = {
  id: string;
  project_id: string;
  activity_type: string;
  description: string;
  created_at: string;
};

export type DiscoveryQuestion = {
  id: string;
  question_ref: string;
  project_id: string;
  question: string;
  owner: string | null;
  category: "Business Rule" | "Replenishment Logic" | "Database" | "Performance" | "Testing" | "UI";
  status: "Open" | "Awaiting Business" | "Awaiting Development" | "Answered" | "Closed";
  due_date: string | null;
  answer: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Milestone = {
  id: string;
  milestone_ref: string;
  project_id: string;
  title: string;
  target_date: string | null;
  status: "Not Started" | "In Progress" | "Complete" | "At Risk" | "Blocked";
  owner: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditActionType =
  | "Create"
  | "Update"
  | "Delete"
  | "Status Change"
  | "Health Change"
  | "Date Change"
  | "Severity Change"
  | "Progress Change"
  | "Schedule Change";

export type AuditLog = {
  id: string;
  project_id: string | null;
  entity_type: string;
  entity_id: string;
  entity_name: string;
  action_type: AuditActionType;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_by_name: string;
  changed_at: string;
};

export type AuditFilter = {
  projectId?: string;
  entityType?: string;
  actionType?: AuditActionType;
  changedBy?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type EntityMap = {
  projects: Project;
  deliverables: Deliverable;
  requirements: Requirement;
  risks: Risk;
  decisions: Decision;
  actions: ActionItem;
  dependencies: Dependency;
  test_cases: TestCase;
  meetings: Meeting;
  documents: DocumentRecord;
  activity_log: ActivityLog;
  discovery_questions: DiscoveryQuestion;
  milestones: Milestone;
  timeline_items: TimelineItem;
  project_snapshots: ProjectSnapshot;
  email_settings: EmailSettings;
  email_activity_log: EmailActivity;
  go_live_checklists: GoLiveChecklist;
  cutover_plan: CutoverStep;
};

export type EntityName = keyof EntityMap;
