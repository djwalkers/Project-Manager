import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  BriefcaseBusiness,
  CalendarDays,
  CalendarRange,
  CheckSquare,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Flag,
  GitBranch,
  GitMerge,
  History,
  LayoutDashboard,
  Library,
  ListChecks,
  Mail,
  Newspaper,
  PackageCheck,
  PanelsTopLeft,
  Rocket,
  Settings,
  ShieldQuestion,
  Sparkles,
  Stethoscope,
  TrendingUp,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  keywords?: string;
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

export const STANDALONE_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/project-workspace", label: "Workspace", icon: PanelsTopLeft },
  { href: "/projects", label: "Projects", icon: BriefcaseBusiness },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/requirements", label: "Requirements", icon: ListChecks },
      { href: "/discovery-questions", label: "Discovery Questions", icon: CircleHelp, keywords: "queries questions" },
      { href: "/decisions", label: "Decisions", icon: ShieldQuestion },
      { href: "/actions", label: "Actions", icon: ClipboardCheck },
      { href: "/risks", label: "Risks", icon: AlertTriangle },
      { href: "/dependencies", label: "Dependencies", icon: GitBranch },
      { href: "/deliverables", label: "Deliverables", icon: PackageCheck },
      { href: "/milestones", label: "Milestones", icon: Flag },
      { href: "/timeline", label: "Timeline", icon: CalendarRange },
      { href: "/testing", label: "Tests", icon: BookOpenCheck, keywords: "test testing" },
      { href: "/go-live-readiness", label: "Go-Live Readiness", icon: Rocket },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    items: [
      { href: "/meetings", label: "Meetings", icon: CalendarDays },
      { href: "/meeting-intelligence", label: "Meeting Intelligence", icon: Sparkles },
      { href: "/acceptance-criteria", label: "Acceptance Criteria", icon: CheckSquare },
      { href: "/evidence", label: "Evidence", icon: Library },
      { href: "/traceability", label: "Traceability", icon: GitMerge },
      { href: "/documents", label: "Documents", icon: FileText },
      { href: "/audit-trail", label: "Audit Trail", icon: History },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [
      { href: "/project-intelligence", label: "Delivery Intelligence", icon: BrainCircuit },
      { href: "/project-trends", label: "Trends", icon: TrendingUp },
      { href: "/daily-brief", label: "Daily Brief", icon: Newspaper },
      { href: "/manager-summary", label: "Manager Summary", icon: ClipboardList },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      { href: "/ai-settings", label: "AI Settings", icon: Bot },
      { href: "/email-settings", label: "Email Settings", icon: Mail },
      { href: "/system-health", label: "System Health", icon: Stethoscope },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const ALL_ITEMS: NavItem[] = [
  ...STANDALONE_ITEMS,
  ...NAV_GROUPS.flatMap((g) => g.items),
];
