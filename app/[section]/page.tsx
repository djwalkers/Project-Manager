import { notFound } from "next/navigation";
import { ModulePageClient, SettingsPageClient } from "@/components/app-client";
import { SystemHealthPage } from "@/components/system-health-page";
import { moduleBySlug } from "@/lib/modules";

export function generateStaticParams() {
  return [
    "projects",
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
  const moduleConfig = moduleBySlug.get(section);
  if (!moduleConfig) notFound();
  return <ModulePageClient section={section} />;
}
