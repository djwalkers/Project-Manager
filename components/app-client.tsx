"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AcceptanceCriteriaPanel } from "@/components/acceptance-criteria-panel";
import { ArtefactLinker } from "@/components/artefact-linker";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { DataTable } from "@/components/data-table";
import { TimelineSchedule } from "@/components/timeline-schedule";
import { resetData, type DataStore } from "@/lib/data-store";
import { moduleBySlug } from "@/lib/modules";
import { useAuth } from "@/contexts/auth-context";
import { loadSelectedProjectId } from "@/lib/project-selection";
import { selectProjectById, selectTimelineItems } from "@/lib/project-scope";
import {
  deleteRecord,
  createRecord,
  hasSupabaseConfig,
  loadData,
  saveRecord,
} from "@/lib/supabase/data-store";
import { useProjectData } from "@/lib/use-project-data";
import type { AcceptanceCriteria, Deliverable } from "@/lib/types";

const LINKABLE = new Set([
  "requirements", "acceptance_criteria", "decisions", "discovery_questions",
  "deliverables", "risks", "actions", "test_cases",
]);

// Map status values to 0–100 percent for readiness bars
function statusToPercent(status: string): number {
  if (!status || status === "Not Started") return 0;
  if (status === "Blocked") return -1; // special: red
  if (["Complete", "Passed", "SIT Complete", "UAT Complete", "Deployed"].includes(status)) return 100;
  if (["Ready", "Ready for SIT", "Ready for UAT", "Ready for Deployment", "Scheduled"].includes(status)) return 75;
  if (["In Development", "In Progress", "In Analysis"].includes(status)) return 50;
  return 25;
}

function ReadinessBar({ label, status }: { label: string; status: string }) {
  const pct = statusToPercent(status);
  const blocked = pct === -1;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className={blocked ? "text-red-600 font-semibold" : "text-muted-foreground"}>{blocked ? "Blocked" : status || "Not Started"}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${blocked ? "bg-red-500" : "bg-primary"}`}
          style={{ width: `${Math.max(0, pct)}%` }}
        />
      </div>
    </div>
  );
}

function DeliverableACReadiness({ row, data }: { row: Row; data: DataStore }) {
  // Show AC readiness aggregated across all requirements in this project
  const pid = String(row.project_id ?? "");
  const allAC = (data.acceptance_criteria ?? []) as AcceptanceCriteria[];
  const projectAC = allAC.filter((ac) => ac.project_id === pid);
  if (!projectAC.length) return null;

  const projectReqs = data.requirements.filter((r) => r.project_id === pid);
  const reqsWith100 = projectReqs.filter((r) => {
    const acs = projectAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.every((ac) => ac.status === "Met" || ac.status === "Waived");
  }).length;
  const reqsWithAC = projectReqs.filter((r) => projectAC.some((ac) => ac.requirement_id === r.id)).length;
  const met = projectAC.filter((ac) => ac.status === "Met" || ac.status === "Waived").length;
  const pct = projectAC.length > 0 ? Math.round((met / projectAC.length) * 100) : 0;

  return (
    <div>
      <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">Acceptance Readiness</p>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="rounded-md bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold tabular-nums">{reqsWithAC}</p>
          <p className="text-xs text-muted-foreground">Requirements</p>
        </div>
        <div className="rounded-md bg-green-50 p-2 text-center">
          <p className="text-lg font-bold tabular-nums text-green-700">{reqsWith100}</p>
          <p className="text-xs text-muted-foreground">AC Complete</p>
        </div>
        <div className="rounded-md bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold tabular-nums">{reqsWithAC - reqsWith100}</p>
          <p className="text-xs text-muted-foreground">Outstanding</p>
        </div>
      </div>
      <div className="mb-1 flex justify-between text-xs">
        <span>Readiness</span><span className="font-semibold">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${pct === 100 ? "bg-green-600" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DeliverableReadiness({ row }: { row: Row }) {
  const d = row as unknown as Deliverable;
  const bars: { label: string; status: string }[] = [
    { label: "Development", status: d.development_status ?? "" },
    { label: "SIT", status: d.sit_status ?? "" },
    { label: "UAT", status: d.uat_status ?? "" },
    { label: "Deployment", status: d.deployment_status ?? "" },
  ];
  const pcts = bars.map((b) => Math.max(0, statusToPercent(b.status)));
  const overall = Math.round(pcts.reduce((sum, p) => sum + p, 0) / 4);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Readiness</p>
        <span className="text-xs font-semibold tabular-nums">{overall}%</span>
      </div>
      <div className="space-y-2">
        {bars.map((bar) => <ReadinessBar key={bar.label} label={bar.label} status={bar.status} />)}
      </div>
    </div>
  );
}

type Row = Record<string, unknown>;

export function ModulePageClient({ section }: { section: string }) {
  const { data, setData, error, reload } = useProjectData();
  const { user } = useAuth();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const config = moduleBySlug.get(section);
  const activeProject = data ? selectProjectById(data, selectedProjectId) : null;
  const timelineScope = data && activeProject ? selectTimelineItems(data, activeProject) : null;
  const pageData = data && config?.key === "timeline_items" && timelineScope
    ? { ...data, timeline_items: timelineScope.items }
    : data;

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  async function persistRecord(record: Row) {
    if (!config) throw new Error("Unknown module");
    const saved = await saveRecord(config.key, {
      ...record,
      ...(config.key === "projects" ? {} : { project_id: record.project_id ?? activeProject?.id }),
    });
    const activity = config.key === "deliverables" && activeProject
      ? await createRecord("activity_log", {
        project_id: activeProject.id,
        activity_type: record.id ? "Deliverable updated" : "Deliverable added",
        description: `${String((saved as Row).deliverable_ref)} ${String((saved as Row).title)} is ${String((saved as Row).status)}.`,
      }).catch(() => null)
      : null;
    setData((current) => {
      if (!current) return current;
      const rows = current[config.key] as Row[];
      const exists = rows.some((row) => row.id === (saved as Row).id);
      const next = {
        ...current,
        [config.key]: exists
          ? rows.map((row) => (row.id === (saved as Row).id ? saved : row))
          : [saved, ...rows],
      } as DataStore;
      return activity ? { ...next, activity_log: [activity, ...next.activity_log] } : next;
    });
    return saved as Row;
  }

  async function removeRecord(record: Row) {
    if (!config || !record.id) throw new Error("Cannot delete a record without an ID");
    await deleteRecord(config.key, String(record.id));
    setData((current) => current
      ? { ...current, [config.key]: current[config.key].filter((item) => item.id !== record.id) } as DataStore
      : current);
  }

  const detailFooter = useCallback((row: Row) => {
    if (!config || !pageData) return null;
    const pid = String(row.project_id ?? activeProject?.id ?? "");
    const recordId = String(row.id ?? "");
    const isDeliverable = config.key === "deliverables";
    const isRequirement = config.key === "requirements";
    if (!isDeliverable && !isRequirement && !LINKABLE.has(config.key)) return null;
    const criteria = (pageData.acceptance_criteria ?? []).filter((ac: AcceptanceCriteria) => ac.requirement_id === recordId);
    const allCriteria = (pageData.acceptance_criteria ?? []) as AcceptanceCriteria[];
    const isTestCase = config.key === "test_cases";
    const testStatus = String(row.status ?? "");
    return (
      <div className="space-y-4">
        {isDeliverable && <DeliverableReadiness row={row} />}
        {isDeliverable && <DeliverableACReadiness row={row} data={pageData} />}
        {isTestCase && testStatus === "Passed" && (
          <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
            This test has Passed. If it validates linked Acceptance Criteria, consider marking those criteria as Met.
          </p>
        )}
        {isRequirement && pid && recordId && (
          <AcceptanceCriteriaPanel
            requirementId={recordId}
            projectId={pid}
            criteria={criteria}
            allCriteria={allCriteria}
            onUpdate={(updated) => {
              setData((current) => {
                if (!current) return current;
                const existingIds = new Set(updated.map((ac) => ac.id));
                const existing = (current.acceptance_criteria ?? []) as AcceptanceCriteria[];
                const kept = existing.filter((ac) => ac.requirement_id !== recordId || existingIds.has(ac.id));
                const newItems = updated.filter((ac) => !existing.some((e) => e.id === ac.id));
                const merged = kept.map((ac) => updated.find((u) => u.id === ac.id) ?? ac);
                return { ...current, acceptance_criteria: [...merged, ...newItems] };
              });
            }}
          />
        )}
        {LINKABLE.has(config.key) && pid && recordId && (
          <ArtefactLinker entity={config.key} recordId={recordId} projectId={pid} data={pageData} />
        )}
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.key, activeProject?.id, pageData]);

  if (!config) return null;
  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data || !pageData) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">CR028 Replenishment</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">{config.title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{config.description}</p>
        </div>
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {pageData[config.key].length} total records
        </p>
      </div>
      {config.key === "documents" ? (
        <div className="mb-5 rounded-lg border bg-secondary p-4 text-sm font-medium text-secondary-foreground">
          Document upload will be added in v2.
        </div>
      ) : null}
      {config.key === "timeline_items" && timelineScope?.mode !== "exact" ? (
        <div className="mb-5 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Timeline project ownership needs review</p>
            <p className="mt-1">{timelineScope?.mode === "duplicate-project" ? "Phases were found against a duplicate CR028 project and are shown here for continuity." : "Timeline records exist, but none belong to the active CR028 project."}</p>
          </div>
        </div>
      ) : null}
      {config.key === "timeline_items" && activeProject && timelineScope ? (
        <TimelineSchedule project={activeProject} items={timelineScope.items} />
      ) : null}
      <DataTable
        config={config}
        data={pageData}
        onSaveRecord={persistRecord}
        onDeleteRecord={removeRecord}
        defaultValues={user?.fullName ? { owner: user.fullName } : undefined}
        detailFooter={detailFooter}
      />
    </AppShell>
  );
}

export function SettingsPageClient() {
  const { data, setData, error, reload } = useProjectData();
  const counts = useMemo(() => {
    if (!data) return [];
    return Object.entries(data).map(([key, value]) => ({ key, count: value.length }));
  }, [data]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <section className="rounded-lg border bg-card p-5 shadow-operational">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {hasSupabaseConfig
            ? "Supabase is configured and is the primary data source for this app."
            : "Supabase credentials can be added to .env.local. Until then, this app keeps a local browser copy."}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {counts.map((item) => (
            <div key={item.key} className="rounded-md border bg-muted/50 p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{item.key.replace("_", " ")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{item.count}</p>
            </div>
          ))}
        </div>
        {!hasSupabaseConfig ? (
          <button
            className="mt-5 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
            onClick={() => {
              resetData();
              loadData().then(setData);
            }}
          >
            Reset local data
          </button>
        ) : null}
      </section>
    </AppShell>
  );
}
