import { notFound } from "next/navigation";
import { ModulePageClient, SettingsPageClient } from "@/components/app-client";
import { DailyBriefPage } from "@/components/daily-brief-page";
import { DecisionsPage } from "@/components/decisions-page";
import { DiscoveryQuestionsPage } from "@/components/discovery-questions-page";
import { ProjectTrendsPage } from "@/components/project-trends-page";
import { ProjectIntelligencePage } from "@/components/project-intelligence-page";
import { ProjectWorkspacePage } from "@/components/project-workspace-page";
import { SystemHealthPage } from "@/components/system-health-page";
import { EmailSettingsPage } from "@/components/email-settings-page";
import { moduleBySlug } from "@/lib/modules";

export function generateStaticParams() {
  return [
    "projects",
    "deliverables",
    "daily-brief",
    "project-trends",
    "project-workspace",
    "project-intelligence",
    "requirements",
    "risks",
    "decisions",
    "discovery-questions",
    "actions",
    "milestones",
    "timeline",
    "dependencies",
    "testing",
    "meetings",
    "documents",
    "system-health",
    "settings",
    "email-settings",
  ].map((section) => ({ section }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section === "settings") return <SettingsPageClient />;
  if (section === "email-settings") return <EmailSettingsPage />;
  if (section === "system-health") return <SystemHealthPage />;
  if (section === "daily-brief") return <DailyBriefPage />;
  if (section === "project-trends") return <ProjectTrendsPage />;
  if (section === "project-workspace") return <ProjectWorkspacePage />;
  if (section === "project-intelligence") return <ProjectIntelligencePage />;
  if (section === "decisions") return <DecisionsPage />;
  if (section === "discovery-questions") return <DiscoveryQuestionsPage />;
  const moduleConfig = moduleBySlug.get(section);
  if (!moduleConfig) notFound();
  return <ModulePageClient section={section} />;
}
