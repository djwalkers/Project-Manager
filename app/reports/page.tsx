"use client";

import {
  FileText,
  Printer,
  ShieldCheck,
  Truck,
  Target,
  AlertTriangle,
} from "lucide-react";
import { useState, useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { useProjectData } from "@/lib/use-project-data";
import { selectActiveProject } from "@/lib/project-scope";
import {
  buildManagementSummary,
  buildNeedsAttention,
  buildUpcomingThisWeek,
  calculateProjectHealth,
  calculateProgress,
} from "@/lib/control-tower";
import { computeDeliveryConfidence } from "@/lib/delivery-confidence";
import { calculateSchedule } from "@/lib/schedule";
import { selectTimelineItems } from "@/lib/project-scope";
import { isOverdue } from "@/lib/utils";

// ── Report definitions ─────────────────────────────────────────────────────────

type ReportId =
  | "executive-status"
  | "raid-log"
  | "delivery-confidence"
  | "requirements-traceability"
  | "go-live-readiness";

type ReportDef = {
  id: ReportId;
  title: string;
  description: string;
  icon: React.ElementType;
};

const REPORT_DEFS: ReportDef[] = [
  {
    id: "executive-status",
    title: "Executive Status Report",
    description: "One-page narrative summary with health, schedule, and key risks.",
    icon: FileText,
  },
  {
    id: "raid-log",
    title: "RAID Log",
    description: "Risks, Actions, Issues and Decisions in a single exportable table.",
    icon: AlertTriangle,
  },
  {
    id: "delivery-confidence",
    title: "Delivery Confidence Report",
    description: "Scored confidence breakdown with gap analysis.",
    icon: Target,
  },
  {
    id: "requirements-traceability",
    title: "Requirements Traceability",
    description: "Requirements mapped to test cases and acceptance criteria.",
    icon: ShieldCheck,
  },
  {
    id: "go-live-readiness",
    title: "Go-Live Readiness",
    description: "Checklist of delivery gates and their current status.",
    icon: Truck,
  },
];

// ── Utility ───────────────────────────────────────────────────────────────────

function today() {
  return new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ── Print button ──────────────────────────────────────────────────────────────

function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted print:hidden"
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      Print / Save as PDF
    </button>
  );
}

// ── Report: Executive Status ──────────────────────────────────────────────────

function ExecutiveStatusReport({ data }: { data: NonNullable<ReturnType<typeof useProjectData>["data"]> }) {
  const project = selectActiveProject(data);
  if (!project) return <p className="text-sm text-muted-foreground">No active project.</p>;

  const timelineScope = selectTimelineItems(data, project);
  const schedule = calculateSchedule(project, timelineScope.items);
  const overdueActions = data.actions.filter((a) => isOverdue(a.due_date, a.status)).length;
  const overdueDecisions = data.decisions.filter((d) => isOverdue(d.due_date, d.status)).length;
  const blockedMilestones = data.milestones.filter((m) => m.status === "Blocked").length + schedule.blocked.length;
  const health = calculateProjectHealth(overdueActions + overdueDecisions, blockedMilestones, schedule.variance ?? -1);
  const summary = buildManagementSummary(project, health, data, overdueActions, schedule);
  const needsAttention = buildNeedsAttention(data).slice(0, 5);
  const upcoming = buildUpcomingThisWeek(data).slice(0, 5);
  const progress = calculateProgress(data, schedule.variance ?? -1);

  const healthColor = health === "Green" ? "#16a34a" : health === "Amber" ? "#d97706" : "#dc2626";

  return (
    <div className="report-body space-y-8">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <p className="text-muted-foreground">{project.customer} · Executive Status Report · {today()}</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Project Health", value: health, color: healthColor },
          { label: "Overall Progress", value: `${progress.overall}%`, color: "#334155" },
          { label: "Overdue Actions", value: overdueActions, color: overdueActions > 0 ? "#dc2626" : "#16a34a" },
          { label: "Blocked Milestones", value: blockedMilestones, color: blockedMilestones > 0 ? "#dc2626" : "#16a34a" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-lg border p-4 text-center">
            <p style={{ color }} className="text-2xl font-bold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-base font-semibold">Executive Summary</h2>
        <p className="leading-7 text-sm text-muted-foreground">{summary}</p>
      </div>

      {needsAttention.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-semibold">Needs Attention</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="pb-2 pr-3">Severity</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Item</th>
                <th className="pb-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {needsAttention.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 pr-3 font-semibold text-red-600 text-xs">{item.severity}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{item.kind}</td>
                  <td className="py-2 pr-3 font-medium">{item.title}</td>
                  <td className="py-2 text-xs text-muted-foreground">{item.meta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {upcoming.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-semibold">Upcoming This Week</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Item</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {upcoming.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{item.kind}</td>
                  <td className="py-2 pr-3 font-medium">{item.title}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums">{item.date ?? "—"}</td>
                  <td className="py-2 text-xs text-muted-foreground">{item.meta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Report: RAID Log ──────────────────────────────────────────────────────────

function RaidLogReport({ data }: { data: NonNullable<ReturnType<typeof useProjectData>["data"]> }) {
  const openRisks = data.risks.filter((r) => !["Complete", "Closed"].includes(r.status));
  const openActions = data.actions.filter((a) => !["Complete", "Closed"].includes(a.status));
  const openDecisions = data.decisions.filter((d) => !["Approved", "Closed"].includes(d.status));

  return (
    <div className="report-body space-y-8">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">RAID Log</h1>
        <p className="text-muted-foreground">Risks, Actions, Issues &amp; Decisions · {today()}</p>
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold">Risks ({openRisks.length} open)</h2>
        {openRisks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open risks.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="pb-2 pr-3">Ref</th>
                <th className="pb-2 pr-3">Description</th>
                <th className="pb-2 pr-3">Impact</th>
                <th className="pb-2 pr-3">Probability</th>
                <th className="pb-2">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {openRisks.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-3 font-semibold text-xs">{r.risk_ref}</td>
                  <td className="py-2 pr-3">{r.description}</td>
                  <td className="py-2 pr-3 text-xs">{r.impact}</td>
                  <td className="py-2 pr-3 text-xs">{r.probability}</td>
                  <td className="py-2 text-xs text-muted-foreground">{r.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold">Actions ({openActions.length} open)</h2>
        {openActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open actions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="pb-2 pr-3">Ref</th>
                <th className="pb-2 pr-3">Description</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Due Date</th>
                <th className="pb-2">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {openActions.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 pr-3 font-semibold text-xs">{a.action_ref}</td>
                  <td className="py-2 pr-3">{a.description}</td>
                  <td className="py-2 pr-3 text-xs">{a.status}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums">{a.due_date ?? "—"}</td>
                  <td className="py-2 text-xs text-muted-foreground">{a.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold">Decisions ({openDecisions.length} open)</h2>
        {openDecisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open decisions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="pb-2 pr-3">Ref</th>
                <th className="pb-2 pr-3">Question</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Due</th>
                <th className="pb-2">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {openDecisions.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 pr-3 font-semibold text-xs">{d.decision_ref}</td>
                  <td className="py-2 pr-3">{d.question}</td>
                  <td className="py-2 pr-3 text-xs">{d.status}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums">{d.due_date ?? "—"}</td>
                  <td className="py-2 text-xs text-muted-foreground">{d.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Report: Delivery Confidence ───────────────────────────────────────────────

function DeliveryConfidenceReport({ data }: { data: NonNullable<ReturnType<typeof useProjectData>["data"]> }) {
  const project = selectActiveProject(data);
  const confidence = computeDeliveryConfidence(data);
  const healthColor = confidence.rag === "Green" ? "#16a34a" : confidence.rag === "Amber" ? "#d97706" : "#dc2626";

  return (
    <div className="report-body space-y-8">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">Delivery Confidence Report</h1>
        <p className="text-muted-foreground">{project?.name} · {today()}</p>
      </div>

      <div className="flex items-center gap-6">
        <div className="text-center">
          <p style={{ color: healthColor }} className="text-6xl font-bold tabular-nums">{confidence.score}%</p>
          <p className="mt-1 text-sm text-muted-foreground">Overall Confidence</p>
        </div>
        <div className="flex-1 rounded-lg border p-4">
          <p className="text-sm font-medium">RAG Status: <span style={{ color: healthColor }} className="font-bold">{confidence.rag}</span></p>
          {confidence.reasons.length === 0 ? (
            <p className="mt-2 text-sm text-green-700">All confidence checks passed — no gaps detected.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {confidence.reasons.map((r) => (
                <li key={r} className="flex items-center gap-2 text-sm">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Report: Requirements Traceability ─────────────────────────────────────────

function RequirementsTraceabilityReport({ data }: { data: NonNullable<ReturnType<typeof useProjectData>["data"]> }) {
  const project = selectActiveProject(data);

  return (
    <div className="report-body space-y-8">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">Requirements Traceability Report</h1>
        <p className="text-muted-foreground">{project?.name} · {today()}</p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="pb-2 pr-3">Ref</th>
            <th className="pb-2 pr-3">Requirement</th>
            <th className="pb-2 pr-3">Status</th>
            <th className="pb-2 pr-3">Test Cases</th>
            <th className="pb-2">Acceptance Criteria</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.requirements.map((req) => {
            const acs = (data.acceptance_criteria ?? []).filter((ac) => ac.requirement_id === req.id);
            return (
              <tr key={req.id}>
                <td className="py-2 pr-3 font-semibold text-xs">{req.requirement_ref}</td>
                <td className="py-2 pr-3">{req.title}</td>
                <td className="py-2 pr-3 text-xs">{req.status}</td>
                <td className="py-2 pr-3 text-xs tabular-nums">—</td>
                <td className="py-2 text-xs tabular-nums">{acs.length > 0 ? `${acs.filter((ac) => ac.status === "Met").length}/${acs.length} met` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Report: Go-Live Readiness ─────────────────────────────────────────────────

function GoLiveReadinessReport({ data }: { data: NonNullable<ReturnType<typeof useProjectData>["data"]> }) {
  const project = selectActiveProject(data);
  const openRisks = data.risks.filter((r) => ["High", "Critical"].includes(r.impact) && !["Complete", "Closed"].includes(r.status));
  const overdueActions = data.actions.filter((a) => isOverdue(a.due_date, a.status));
  const blockedMilestones = data.milestones.filter((m) => m.status === "Blocked");
  const acs = data.acceptance_criteria ?? [];
  const acMet = acs.filter((ac) => ac.status === "Met" || ac.status === "Waived").length;

  const gates = [
    { label: "No critical/high open risks", passed: openRisks.length === 0, detail: openRisks.length > 0 ? `${openRisks.length} risk(s) require resolution` : "All high/critical risks resolved" },
    { label: "No overdue actions", passed: overdueActions.length === 0, detail: overdueActions.length > 0 ? `${overdueActions.length} action(s) overdue` : "All actions on track" },
    { label: "No blocked milestones", passed: blockedMilestones.length === 0, detail: blockedMilestones.length > 0 ? `${blockedMilestones.length} milestone(s) blocked` : "All milestones unblocked" },
    { label: "Acceptance criteria met", passed: acs.length > 0 && acMet === acs.length, detail: acs.length > 0 ? `${acMet}/${acs.length} criteria met` : "No acceptance criteria defined" },
    { label: "All deliverables deployed", passed: data.deliverables.every((d) => ["Complete", "Deployed"].includes(d.status)), detail: `${data.deliverables.filter((d) => !["Complete", "Deployed"].includes(d.status)).length} deliverable(s) outstanding` },
  ];

  const allPassed = gates.every((g) => g.passed);

  return (
    <div className="report-body space-y-8">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">Go-Live Readiness Report</h1>
        <p className="text-muted-foreground">{project?.name} · {today()}</p>
      </div>

      <div className="rounded-lg border p-4 text-center">
        <p className={`text-2xl font-bold ${allPassed ? "text-green-700" : "text-amber-600"}`}>
          {allPassed ? "Ready to Go Live" : "Not Yet Ready"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{gates.filter((g) => g.passed).length} of {gates.length} gates passed</p>
      </div>

      <div className="space-y-2">
        {gates.map((gate) => (
          <div key={gate.label} className="flex items-center gap-3 rounded-md border p-3">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${gate.passed ? "bg-green-600" : "bg-amber-500"}`}>
              {gate.passed ? "✓" : "!"}
            </span>
            <div>
              <p className="text-sm font-medium">{gate.label}</p>
              <p className="text-xs text-muted-foreground">{gate.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Reports page ──────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { data, error, reload } = useProjectData();
  const [activeReport, setActiveReport] = useState<ReportId | null>(null);

  const activeReportDef = useMemo(
    () => REPORT_DEFS.find((r) => r.id === activeReport) ?? null,
    [activeReport],
  );

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  function renderReport() {
    if (!data) return null;
    switch (activeReport) {
      case "executive-status": return <ExecutiveStatusReport data={data} />;
      case "raid-log": return <RaidLogReport data={data} />;
      case "delivery-confidence": return <DeliveryConfidenceReport data={data} />;
      case "requirements-traceability": return <RequirementsTraceabilityReport data={data} />;
      case "go-live-readiness": return <GoLiveReadinessReport data={data} />;
      default: return null;
    }
  }

  return (
    <AppShell>
      <style>{`
        @media print {
          .print\\:hidden { display: none !important; }
          body { background: white; }
          .report-body { font-size: 11pt; }
          table { page-break-inside: avoid; }
        }
      `}</style>

      {/* Report selection panel */}
      {!activeReport && (
        <div className="print:hidden">
          <div className="mb-6">
            <p className="text-sm font-medium text-primary">Reports</p>
            <h1 className="mt-1 text-2xl font-semibold">Executive Reports</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate and print project reports for stakeholder review.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {REPORT_DEFS.map((report) => {
              const Icon = report.icon;
              return (
                <button
                  key={report.id}
                  type="button"
                  onClick={() => setActiveReport(report.id)}
                  className="flex items-start gap-4 rounded-lg border bg-card p-5 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-semibold">{report.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{report.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active report */}
      {activeReport && (
        <div>
          {/* Controls (hidden in print) */}
          <div className="mb-6 flex items-center justify-between print:hidden">
            <div>
              <button
                type="button"
                onClick={() => setActiveReport(null)}
                className="mb-2 text-xs text-primary hover:underline"
              >
                ← Back to Reports
              </button>
              <h1 className="text-2xl font-semibold">{activeReportDef?.title}</h1>
            </div>
            <PrintButton />
          </div>

          {/* Report content */}
          <div className="rounded-lg border bg-card p-8 shadow-sm">
            {renderReport()}
          </div>

          <div className="mt-4 flex justify-end print:hidden">
            <PrintButton />
          </div>
        </div>
      )}
    </AppShell>
  );
}
