import {
  AlertTriangle,
  BookOpenCheck,
  BriefcaseBusiness,
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  FileText,
  Flag,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Settings,
  ShieldQuestion,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { EntityName } from "@/lib/types";

export type ModuleConfig = {
  key: EntityName;
  slug: string;
  title: string;
  singular: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  statusField?: string;
  searchFields: string[];
  columns: { key: string; label: string; type?: "status" | "priority" | "date" | "impact" }[];
  fields: { key: string; label: string; type?: "textarea" | "date" | "number" | "select"; options?: string[] }[];
};

export const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: BriefcaseBusiness },
  { href: "/requirements", label: "Requirements", icon: ListChecks },
  { href: "/risks", label: "Risks", icon: AlertTriangle },
  { href: "/decisions", label: "Decisions", icon: ShieldQuestion },
  { href: "/discovery-questions", label: "Discovery Questions", icon: CircleHelp },
  { href: "/actions", label: "Actions", icon: ClipboardCheck },
  { href: "/milestones", label: "Milestones", icon: Flag },
  { href: "/dependencies", label: "Dependencies", icon: GitBranch },
  { href: "/testing", label: "Testing", icon: BookOpenCheck },
  { href: "/meetings", label: "Meetings", icon: CalendarDays },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];

const statusOptions = ["Discovery", "Open", "In Progress", "Pending", "Blocked", "Approved", "Complete", "Closed"];
const priorityOptions = ["Low", "Medium", "High", "Critical"];
const requirementCategoryOptions = ["Business Rule", "Database", "Backend", "UI", "Performance", "Testing"];
const discoveryStatusOptions = ["Open", "Awaiting Business", "Awaiting Development", "Answered", "Closed"];
const discoveryCategoryOptions = ["Business Rule", "Replenishment Logic", "Database", "Performance", "Testing", "UI"];
const milestoneStatusOptions = ["Not Started", "In Progress", "Complete", "At Risk", "Blocked"];
const testStatusOptions = ["Pending", "In Progress", "Passed", "Failed", "Blocked"];

export const modules: ModuleConfig[] = [
  {
    key: "projects",
    slug: "projects",
    title: "Projects",
    singular: "Project",
    description: "Manage the active project and workstream context.",
    icon: BriefcaseBusiness,
    searchFields: ["name", "customer", "workstream", "status"],
    columns: [
      { key: "name", label: "Project" },
      { key: "customer", label: "Customer" },
      { key: "workstream", label: "Workstream" },
      { key: "health", label: "Health", type: "status" },
      { key: "status", label: "Status", type: "status" },
    ],
    fields: [
      { key: "name", label: "Project name" },
      { key: "customer", label: "Customer" },
      { key: "workstream", label: "Workstream" },
      { key: "status", label: "Status", type: "select", options: statusOptions },
      { key: "health", label: "Project health", type: "select", options: ["Green", "Amber", "Red"] },
      { key: "schedule_variance", label: "Schedule variance (%)", type: "number" },
      { key: "description", label: "Description", type: "textarea" },
    ],
  },
  {
    key: "requirements",
    slug: "requirements",
    title: "Requirements",
    singular: "Requirement",
    description: "Track CR028 Replenishment requirements from discovery through approval.",
    icon: ListChecks,
    searchFields: ["requirement_ref", "title", "owner", "source", "status"],
    columns: [
      { key: "requirement_ref", label: "Ref" },
      { key: "title", label: "Requirement" },
      { key: "priority", label: "Priority", type: "priority" },
      { key: "category", label: "Category" },
      { key: "status", label: "Status", type: "status" },
      { key: "owner", label: "Owner" },
    ],
    fields: [
      { key: "requirement_ref", label: "Reference" },
      { key: "title", label: "Title" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "priority", label: "Priority", type: "select", options: priorityOptions },
      { key: "category", label: "Category", type: "select", options: requirementCategoryOptions },
      { key: "status", label: "Status", type: "select", options: statusOptions },
      { key: "owner", label: "Owner" },
      { key: "source", label: "Source" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    key: "risks",
    slug: "risks",
    title: "Risks",
    singular: "Risk",
    description: "Monitor delivery, data volume and replenishment logic risks.",
    icon: AlertTriangle,
    searchFields: ["risk_ref", "description", "owner", "status"],
    columns: [
      { key: "risk_ref", label: "Ref" },
      { key: "description", label: "Risk" },
      { key: "impact", label: "Impact", type: "impact" },
      { key: "probability", label: "Probability" },
      { key: "status", label: "Status", type: "status" },
    ],
    fields: [
      { key: "risk_ref", label: "Reference" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "impact", label: "Impact", type: "select", options: priorityOptions },
      { key: "probability", label: "Probability", type: "select", options: ["Low", "Medium", "High"] },
      { key: "mitigation", label: "Mitigation", type: "textarea" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "select", options: statusOptions },
    ],
  },
  {
    key: "decisions",
    slug: "decisions",
    title: "Decisions",
    singular: "Decision",
    description: "Keep open design and business decisions visible.",
    icon: ShieldQuestion,
    searchFields: ["decision_ref", "question", "decision", "owner", "status"],
    columns: [
      { key: "decision_ref", label: "Ref" },
      { key: "question", label: "Question" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "status" },
      { key: "due_date", label: "Due", type: "date" },
    ],
    fields: [
      { key: "decision_ref", label: "Reference" },
      { key: "question", label: "Question", type: "textarea" },
      { key: "decision", label: "Decision", type: "textarea" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "select", options: statusOptions },
      { key: "decision_date", label: "Decision date", type: "date" },
      { key: "due_date", label: "Due date", type: "date" },
    ],
  },
  {
    key: "discovery_questions",
    slug: "discovery-questions",
    title: "Discovery Questions",
    singular: "Discovery Question",
    description: "Track unanswered business and technical questions through discovery.",
    icon: CircleHelp,
    searchFields: ["question_ref", "question", "owner", "category", "status"],
    columns: [
      { key: "question_ref", label: "Ref" },
      { key: "question", label: "Question" },
      { key: "category", label: "Category" },
      { key: "owner", label: "Owner" },
      { key: "due_date", label: "Due", type: "date" },
      { key: "status", label: "Status", type: "status" },
    ],
    fields: [
      { key: "question_ref", label: "Reference" },
      { key: "question", label: "Question", type: "textarea" },
      { key: "owner", label: "Owner" },
      { key: "category", label: "Category", type: "select", options: discoveryCategoryOptions },
      { key: "status", label: "Status", type: "select", options: discoveryStatusOptions },
      { key: "due_date", label: "Due date", type: "date" },
      { key: "answer", label: "Answer", type: "textarea" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    key: "actions",
    slug: "actions",
    title: "Actions",
    singular: "Action",
    description: "Track ownership, due dates and overdue follow-up.",
    icon: ClipboardCheck,
    searchFields: ["action_ref", "description", "owner", "status"],
    columns: [
      { key: "action_ref", label: "Ref" },
      { key: "description", label: "Action" },
      { key: "owner", label: "Owner" },
      { key: "due_date", label: "Due", type: "date" },
      { key: "status", label: "Status", type: "status" },
    ],
    fields: [
      { key: "action_ref", label: "Reference" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "owner", label: "Owner" },
      { key: "due_date", label: "Due date", type: "date" },
      { key: "status", label: "Status", type: "select", options: statusOptions },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    key: "milestones",
    slug: "milestones",
    title: "Milestones",
    singular: "Milestone",
    description: "Track delivery gates, target dates and milestone health.",
    icon: Flag,
    searchFields: ["milestone_ref", "title", "owner", "status"],
    columns: [
      { key: "milestone_ref", label: "Ref" },
      { key: "title", label: "Milestone" },
      { key: "target_date", label: "Target", type: "date" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "status" },
    ],
    fields: [
      { key: "milestone_ref", label: "Reference" },
      { key: "title", label: "Title" },
      { key: "target_date", label: "Target date", type: "date" },
      { key: "status", label: "Status", type: "select", options: milestoneStatusOptions },
      { key: "owner", label: "Owner" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    key: "dependencies",
    slug: "dependencies",
    title: "Dependencies",
    singular: "Dependency",
    description: "Track technical and process dependencies for the workstream.",
    icon: GitBranch,
    searchFields: ["name", "owner", "status", "notes"],
    columns: [
      { key: "name", label: "Dependency" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "status" },
      { key: "notes", label: "Notes" },
    ],
    fields: [
      { key: "name", label: "Name" },
      { key: "owner", label: "Owner" },
      { key: "status", label: "Status", type: "select", options: statusOptions },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  {
    key: "test_cases",
    slug: "testing",
    title: "Testing",
    singular: "Test Case",
    description: "Plan focused date-range replenishment validation.",
    icon: BookOpenCheck,
    searchFields: ["test_ref", "scenario", "owner", "status"],
    columns: [
      { key: "test_ref", label: "Ref" },
      { key: "scenario", label: "Scenario" },
      { key: "status", label: "Status", type: "status" },
      { key: "owner", label: "Owner" },
    ],
    fields: [
      { key: "test_ref", label: "Reference" },
      { key: "scenario", label: "Scenario", type: "textarea" },
      { key: "expected_result", label: "Expected result", type: "textarea" },
      { key: "actual_result", label: "Actual result", type: "textarea" },
      { key: "status", label: "Status", type: "select", options: testStatusOptions },
      { key: "owner", label: "Owner" },
    ],
  },
  {
    key: "meetings",
    slug: "meetings",
    title: "Meetings",
    singular: "Meeting",
    description: "Capture meeting notes, decisions and actions.",
    icon: CalendarDays,
    searchFields: ["title", "attendees", "notes", "meeting_date"],
    columns: [
      { key: "meeting_date", label: "Date", type: "date" },
      { key: "title", label: "Title" },
      { key: "attendees", label: "Attendees" },
      { key: "actions", label: "Actions" },
    ],
    fields: [
      { key: "meeting_date", label: "Meeting date", type: "date" },
      { key: "title", label: "Title" },
      { key: "attendees", label: "Attendees" },
      { key: "notes", label: "Notes", type: "textarea" },
      { key: "decisions", label: "Decisions", type: "textarea" },
      { key: "actions", label: "Actions", type: "textarea" },
    ],
  },
  {
    key: "documents",
    slug: "documents",
    title: "Documents",
    singular: "Document",
    description: "Record document references. Document upload will be added in v2.",
    icon: FileText,
    searchFields: ["document_name", "document_type", "notes"],
    columns: [
      { key: "document_name", label: "Document" },
      { key: "document_type", label: "Type" },
      { key: "uploaded_at", label: "Uploaded", type: "date" },
      { key: "notes", label: "Notes" },
    ],
    fields: [
      { key: "document_name", label: "Document name" },
      { key: "document_type", label: "Type" },
      { key: "storage_path", label: "Storage path" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
];

export const moduleBySlug = new Map(modules.map((config) => [config.slug, config]));
export const moduleByKey = new Map(modules.map((config) => [config.key, config]));

export const settingsModule = {
  title: "Settings",
  icon: MessageSquareText,
};
