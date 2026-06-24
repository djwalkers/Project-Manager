import { notFound } from "next/navigation";
import { ModulePageClient, SettingsPageClient } from "@/components/app-client";
import { DailyBriefPage } from "@/components/daily-brief-page";
import { ProjectTrendsPage } from "@/components/project-trends-page";
import { SystemHealthPage } from "@/components/system-health-page";
import { moduleBySlug } from "@/lib/modules";

export function generateStaticParams() {
  return [
    "projects",
    "daily-brief",
    "project-trends",
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
  ].map((section) => ({ section }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section === "settings") return <SettingsPageClient />;
  if (section === "system-health") return <SystemHealthPage />;
  if (section === "daily-brief") return <DailyBriefPage />;
  if (section === "project-trends") return <ProjectTrendsPage />;
  const moduleConfig = moduleBySlug.get(section);
  if (!moduleConfig) notFound();
  return <ModulePageClient section={section} />;
}
