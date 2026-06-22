"use client";

import {
  AlertTriangle,
  ClipboardCheck,
  Gauge,
  ListChecks,
  ShieldQuestion,
  TestTube2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { KpiCard } from "@/components/kpi-card";
import { StatusBadge } from "@/components/status-badge";
import { loadData, type DataStore } from "@/lib/data-store";
import { isOverdue } from "@/lib/utils";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ListPanel({
  items,
  render,
}: {
  items: unknown[];
  render: (item: Record<string, unknown>) => React.ReactNode;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No records to show.</p>;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={String((item as Record<string, unknown>).id)} className="rounded-md border bg-muted/40 p-3">
          {render(item as Record<string, unknown>)}
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DataStore | null>(null);

  useEffect(() => {
    setData(loadData());
  }, []);

  const metrics = useMemo(() => {
    if (!data) return null;
    const open = (status?: unknown) => !["Complete", "Approved", "Closed"].includes(String(status ?? ""));
    return {
      openRequirements: data.requirements.filter((item) => open(item.status)).length,
      openRisks: data.risks.filter((item) => open(item.status)).length,
      openActions: data.actions.filter((item) => open(item.status)).length,
      overdueActions: data.actions.filter((item) => isOverdue(item.due_date, item.status)).length,
      openDecisions: data.decisions.filter((item) => open(item.status)).length,
      pendingTests: data.test_cases.filter((item) => item.status === "Pending").length,
    };
  }, [data]);

  if (!data || !metrics) return null;

  const project = data.projects[0];
  const recentActivity = data.activity_log.slice(0, 5);
  const upcomingActions = [...data.actions]
    .filter((item) => !["Complete", "Closed"].includes(item.status))
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 5);
  const highRisks = data.risks.filter((risk) => ["High", "Critical"].includes(risk.impact)).slice(0, 5);
  const openDecisions = data.decisions.filter((decision) => !["Approved", "Closed"].includes(decision.status)).slice(0, 5);

  return (
    <AppShell>
      <div className="mb-6 flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Project Control Centre</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">{project.name}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Lightweight control for the {project.customer} {project.workstream} workstream. Current phase: {project.status}.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg border bg-card p-3 text-sm">
          <div>
            <p className="text-muted-foreground">Customer</p>
            <p className="font-semibold">{project.customer}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Workstream</p>
            <p className="font-semibold">{project.workstream}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Status</p>
            <StatusBadge value={project.status} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <KpiCard title="Open Requirements" value={metrics.openRequirements} helper="Discovery and build items" icon={ListChecks} />
        <KpiCard title="Open Risks" value={metrics.openRisks} helper="Active delivery risks" icon={AlertTriangle} tone="danger" />
        <KpiCard title="Open Actions" value={metrics.openActions} helper="Owned follow-ups" icon={ClipboardCheck} />
        <KpiCard title="Overdue Actions" value={metrics.overdueActions} helper="Needs attention" icon={Gauge} tone={metrics.overdueActions ? "danger" : "good"} />
        <KpiCard title="Open Decisions" value={metrics.openDecisions} helper="Awaiting agreement" icon={ShieldQuestion} tone="warn" />
        <KpiCard title="Pending Test Cases" value={metrics.pendingTests} helper="Ready for planning" icon={TestTube2} tone="warn" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Panel title="Project Summary">
          <div className="space-y-3 text-sm">
            <p>{project.description}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Primary concern</p>
                <p className="mt-1">Date-range demand aggregation and load balancing.</p>
              </div>
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Next focus</p>
                <p className="mt-1">Confirm rules with Sysco and development.</p>
              </div>
            </div>
          </div>
        </Panel>
        <Panel title="Recent Activity">
          <ListPanel
            items={recentActivity}
            render={(item) => (
              <>
                <p className="font-medium">{String(item.activity_type)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{String(item.description)}</p>
              </>
            )}
          />
        </Panel>
        <Panel title="Upcoming Actions">
          <ListPanel
            items={upcomingActions}
            render={(item) => (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{String(item.action_ref)}</p>
                  <StatusBadge value={String(item.status)} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{String(item.description)}</p>
                <p className="mt-2 text-xs font-medium">Due {String(item.due_date)} / {String(item.owner)}</p>
              </>
            )}
          />
        </Panel>
        <Panel title="High Risks">
          <ListPanel
            items={highRisks}
            render={(item) => (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{String(item.risk_ref)}</p>
                  <StatusBadge value={String(item.impact)} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{String(item.description)}</p>
              </>
            )}
          />
        </Panel>
        <Panel title="Open Decisions">
          <ListPanel
            items={openDecisions}
            render={(item) => (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{String(item.decision_ref)}</p>
                  <StatusBadge value={String(item.status)} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{String(item.question)}</p>
              </>
            )}
          />
        </Panel>
        <Panel title="Workstream Health">
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
              <span>Critical requirements</span>
              <strong>{data.requirements.filter((item) => item.priority === "Critical").length}</strong>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
              <span>Technical dependencies</span>
              <strong>{data.dependencies.length}</strong>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
              <span>Planned tests</span>
              <strong>{data.test_cases.length}</strong>
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
