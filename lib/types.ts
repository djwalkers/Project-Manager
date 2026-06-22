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

export type Project = {
  id: string;
  name: string;
  customer: string;
  workstream: string;
  status: Status;
  health: ProjectHealth;
  schedule_variance: number;
  description: string;
  created_at: string;
  updated_at: string;
};

export type Requirement = {
  id: string;
  project_id: string;
  requirement_ref: string;
  title: string;
  description: string;
  priority: Priority;
  category: RequirementCategory;
  status: Status;
  owner: string;
  source: string;
  notes: string;
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
  mitigation: string;
  owner: string;
  status: Status;
  created_at: string;
  updated_at: string;
};

export type Decision = {
  id: string;
  project_id: string;
  decision_ref: string;
  question: string;
  decision: string;
  owner: string;
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
  owner: string;
  due_date: string;
  status: Status;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type Dependency = {
  id: string;
  project_id: string;
  name: string;
  owner: string;
  status: Status;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type TestCase = {
  id: string;
  project_id: string;
  test_ref: string;
  scenario: string;
  expected_result: string;
  actual_result: string;
  status: TestStatus;
  owner: string;
  created_at: string;
  updated_at: string;
};

export type Meeting = {
  id: string;
  project_id: string;
  meeting_date: string;
  title: string;
  attendees: string;
  notes: string;
  decisions: string;
  actions: string;
  created_at: string;
  updated_at: string;
};

export type DocumentRecord = {
  id: string;
  project_id: string;
  document_name: string;
  document_type: string;
  storage_path: string;
  notes: string;
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
  owner: string;
  category: "Business Rule" | "Replenishment Logic" | "Database" | "Performance" | "Testing" | "UI";
  status: "Open" | "Awaiting Business" | "Awaiting Development" | "Answered" | "Closed";
  due_date: string | null;
  answer: string;
  notes: string;
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
  owner: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type EntityMap = {
  projects: Project;
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
};

export type EntityName = keyof EntityMap;
