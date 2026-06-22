import { notFound } from "next/navigation";
import { ModulePageClient, SettingsPageClient } from "@/components/app-client";
import { moduleBySlug } from "@/lib/modules";

export function generateStaticParams() {
  return [
    "projects",
    "requirements",
    "risks",
    "decisions",
    "actions",
    "dependencies",
    "testing",
    "meetings",
    "documents",
    "settings",
  ].map((section) => ({ section }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section === "settings") return <SettingsPageClient />;
  const moduleConfig = moduleBySlug.get(section);
  if (!moduleConfig) notFound();
  return <ModulePageClient section={section} />;
}
