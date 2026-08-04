// Phase C — the real ProjectState AI DTO.
//
// Builds a compact, serializable projection of ProjectState for the Local
// Ollama Project Assistant (see local-gateway/). Supersedes the Phase A1/A2
// stub contract ({ generatedAt, project: { name }, sourceRefs: [] }) with
// the real facts an assistant needs to answer status/health/feasibility
// questions, while staying small, bounded, and safe to hand to a model.
//
// Exactly one explicit call in: buildProjectState(data, project, now). This
// never re-selects a project itself (no selectActiveProject/
// selectCanonicalProjects here) — callers resolve "which project" exactly
// once and pass it in, same discipline as buildProjectState itself (see
// lib/project-state.ts's doc comment).
//
// Excluded by construction: raw UUIDs (every `.ref` below is a business
// reference like "RSK-001", never a record's `.id`), API keys, session
// tokens, service-role data (this module never touches Supabase directly),
// other projects' data (everything is read from ProjectState.scoped, which
// is already scoped to the one project passed in), full audit history, and
// unbounded raw tables. Historical snapshot fields (project_snapshots'
// progress_percent/schedule_variance) are structurally excluded too — this
// DTO is built only from live buildProjectState(...) output and never reads
// data.project_snapshots (see plan Part 16).
//
// local-gateway/prompt.js embeds this DTO's JSON verbatim into the model's
// system prompt and independently re-validates every citation against
// dto.sourceRefs. The two files don't share code across the process
// boundary (local-gateway/ has zero dependencies on this app) — if a field
// name changes here, local-gateway/lib.js's REQUIRED_DTO_KEYS and
// local-gateway/prompt.js must be checked too.
import type { DataStore } from "@/lib/data-store";
import { buildProjectState, type LifecycleRollups } from "@/lib/project-state";
import type { RagStatus } from "@/lib/control-tower";
import {
  isAcceptanceCriteriaOutstanding,
  isActionOpen,
  isDecisionOpen,
  isDependencyOpen,
  isRiskOpen,
  isTestFailedOrBlocked,
} from "@/lib/lifecycle";
import type { DateConfidence, ManagementAction } from "@/lib/manager-summary";
import type { GoLiveDateSource } from "@/lib/project-dates";
import type { GoLiveStatus, ReadinessCheckStatus } from "@/lib/go-live-readiness";
import type { ProjectPhase } from "@/lib/project-phase";
import type { GoLiveChecklist, Milestone, Project, TimelineItem } from "@/lib/types";

// ── Caps & truncation (Phase C requirement 4) — exact limits ────────────────
// Every list below is capped and every free-text field truncated so the DTO
// stays small and bounded regardless of how large the underlying project is.
const MAX_TEXT_LENGTH = 120;            // titles/descriptions/questions/criteria/reasons/evidence
const MAX_RECOMMENDATIONS = 10;         // ProjectState already caps recommendations at 10 (Phase 7); reasserted here
const MAX_REASONS = 5;                  // deliveryConfidence.reasons (computeDeliveryConfidence already caps at 5)
const MAX_LIST_ITEMS = 12;              // openRisks, openActions, openDecisions, failedOrBlockedTests, outstandingAcceptanceCriteria, customerOwnedItems
const MAX_DEPENDENCIES = 10;
const MAX_SCHEDULE_EVIDENCE_ITEMS = 10; // upcomingMilestones / activeTimelineItems, each

function truncate(value: string, max = MAX_TEXT_LENGTH): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ── Customer-ownership tiers (Phase C requirement 5) ─────────────────────────
// Never a bare boolean, never presented as confirmed fact from a name match
// alone. Built only from go_live_checklists rows — the one place in this
// codebase that already carries both an owner-name signal (e.g. "Sysco
// (Customer)") and an explicit documented reason (e.g. "Customer-owned
// activity outside Bluestonex delivery scope." on a Customer Approval item —
// see tests/phase-1-provider-scope.test.mjs). Deliverables/actions/decisions
// have owner fields too, but no established documented-reason precedent
// exists for those in this codebase, so they're left out rather than
// guessed at. This tiering exists for genuinely provider-relevant external
// dependencies (customer sign-off, customer-provided access/data) — it must
// never be used to surface customer operational/organisational activity
// (training, adoption, change management) that sits outside the provider's
// software-delivery scope (see the post-audit Phase 1 removal of the
// "Warehouse Training" go-live check, which was exactly that).
export type OwnershipConfidence = "confirmed_customer_owned" | "likely_customer_owned" | "unknown";

const CUSTOMER_OWNED_REASON_PATTERN = /customer[- ]owned|owned by (the )?customer|outside .*delivery scope/i;

function ownerMatchesCustomer(owner: string | null | undefined, customer: string): boolean {
  const text = owner?.trim().toLowerCase();
  if (!text) return false;
  return text.includes("customer") || (customer.trim().length > 0 && text.includes(customer.trim().toLowerCase()));
}

export type CustomerOwnedItem = {
  ref: string;
  label: string;
  kind: string;
  ownership: OwnershipConfidence;
  evidence: string;
};

// checklist rows have no natural business reference (GoLiveChecklist has no
// *_ref field, only an internal id) — a synthetic "GLC-<n>" ref is minted
// per project so these can still be cited like every other list item,
// without ever exposing the row's raw UUID.
// A checklist row's category is a free-text DB column, not a runtime-
// constrained enum (see supabase/migrations/012_go_live_readiness.sql) — a
// historical row can still literally carry category "Training" even though
// it's no longer a valid GoLiveChecklistCategory. Training/warehouse-
// training items are customer operational readiness, out of scope for this
// provider software-delivery tool (post-audit Phase 1) — they must never
// reach the AI assistant's context, regardless of any owner/reason signal.
const OUT_OF_SCOPE_CHECKLIST_PATTERN = /training/i;

function buildCustomerOwnedItems(checklists: GoLiveChecklist[], customer: string): CustomerOwnedItem[] {
  const items: CustomerOwnedItem[] = [];
  checklists.forEach((item, index) => {
    if (OUT_OF_SCOPE_CHECKLIST_PATTERN.test(item.category) || OUT_OF_SCOPE_CHECKLIST_PATTERN.test(item.item)) return;
    const ownerMatch = ownerMatchesCustomer(item.owner, customer);
    const reasonText = item.notes ?? "";
    const explicitReason = CUSTOMER_OWNED_REASON_PATTERN.test(reasonText);
    if (!ownerMatch && !explicitReason) return; // no signal at all — not surfaced

    const ownership: OwnershipConfidence = ownerMatch && explicitReason
      ? "confirmed_customer_owned"
      : ownerMatch
        ? "likely_customer_owned"
        : "unknown"; // reason text mentions customer ownership, but the owner field doesn't corroborate it

    const evidence = ownerMatch && explicitReason
      ? `Owner "${item.owner}"; ${reasonText}`
      : ownerMatch
        ? `Owner "${item.owner}"`
        : reasonText;

    items.push({
      ref: `GLC-${index + 1}`,
      label: truncate(item.item),
      kind: item.category,
      ownership,
      evidence: truncate(evidence),
    });
  });
  return items.slice(0, MAX_LIST_ITEMS);
}

// ── Schedule evidence (Phase C requirement 6) ────────────────────────────────
export type UpcomingMilestone = { ref: string; title: string; date: string | null; status: string };
export type ActiveTimelineItem = { phase: string; endDate: string; progressPercent: number; status: string };

function buildUpcomingMilestones(milestones: Milestone[]): UpcomingMilestone[] {
  return [...milestones]
    .filter((m) => !["Complete", "Closed"].includes(m.status))
    .sort((a, b) => String(a.target_date ?? "").localeCompare(String(b.target_date ?? "")))
    .slice(0, MAX_SCHEDULE_EVIDENCE_ITEMS)
    .map((m) => ({ ref: m.milestone_ref, title: truncate(m.title), date: m.target_date, status: m.status }));
}

// Blocked and at-risk items surface before plain in-progress ones — the same
// priority order lib/project-phase.ts's timelineEvidence() already uses for
// "what's actually happening on this project right now".
function buildActiveTimelineItems(blocked: TimelineItem[], atRisk: TimelineItem[], active: TimelineItem[]): ActiveTimelineItem[] {
  return [...blocked, ...atRisk, ...active]
    .slice(0, MAX_SCHEDULE_EVIDENCE_ITEMS)
    .map((item) => ({
      phase: truncate(item.phase_name),
      endDate: item.end_date,
      progressPercent: item.progress_percent,
      status: item.status,
    }));
}

// ── The DTO ───────────────────────────────────────────────────────────────────

export type ProjectAssistantDTO = {
  generatedAt: string;
  project: { name: string; customer: string; workstream: string; status: string };
  phase: { phase: ProjectPhase; confidence: number; source: string; detail: string };
  schedule: { health: RagStatus | null; variance: number | null; daysRemaining: number | null; projectStart: string | null; projectEnd: string | null };
  goLiveDate: { date: string | null; source: GoLiveDateSource; milestoneTitle: string | null };
  projectHealth: { status: RagStatus; summary: string; attentionRequired: string | null; dateConfidence: DateConfidence; managementAction: ManagementAction };
  deliveryConfidence: { score: number; rag: RagStatus; reasons: string[] };
  goLiveReadiness: {
    status: GoLiveStatus;
    readinessPercent: number;
    checks: Array<{
      key: string;
      label: string;
      source: "Auto" | "Manual";
      effective: ReadinessCheckStatus;
      derived: ReadinessCheckStatus;
      override: { status: ReadinessCheckStatus; reason: string; by: string; at: string } | null;
    }>;
  };
  rollups: LifecycleRollups;
  recommendations: Array<{ ref: string | null; title: string; reason: string; urgency: string; type: string }>;
  openRisks: Array<{ ref: string; description: string; impact: string; owner: string | null }>;
  openActions: Array<{ ref: string; description: string; owner: string | null; dueDate: string | null }>;
  openDecisions: Array<{ ref: string; question: string; owner: string | null; dueDate: string | null }>;
  openDependencies: Array<{ name: string; owner: string | null }>;
  failedOrBlockedTests: Array<{ ref: string; scenario: string; status: string }>;
  outstandingAcceptanceCriteria: Array<{ ref: string; criterion: string; status: string; requirementRef: string | null }>;
  customerOwnedItems: CustomerOwnedItem[];
  scheduleEvidence: { upcomingMilestones: UpcomingMilestone[]; activeTimelineItems: ActiveTimelineItem[] };
  sourceRefs: string[];
};

/**
 * Builds the compact ProjectState AI DTO for exactly one project. Calls
 * buildProjectState(data, project, now) once — never re-selects a project,
 * never reads data.project_snapshots.
 */
export function buildProjectAssistantDTO(data: DataStore, project: Project, now = new Date()): ProjectAssistantDTO {
  const state = buildProjectState(data, project, now);
  const scoped = state.scoped;
  const refs = new Set<string>();
  const addRef = (ref: string | null | undefined) => { if (ref) refs.add(ref); };

  const recommendations = state.recommendations.slice(0, MAX_RECOMMENDATIONS).map((r) => {
    addRef(r.ref ?? null);
    return { ref: r.ref ?? null, title: truncate(r.title), reason: truncate(r.reason), urgency: r.urgency, type: r.type };
  });

  const openRisks = scoped.risks.filter((r) => isRiskOpen(r.status)).slice(0, MAX_LIST_ITEMS).map((r) => {
    addRef(r.risk_ref);
    return { ref: r.risk_ref, description: truncate(r.description), impact: r.impact, owner: r.owner ?? null };
  });

  const openActions = scoped.actions.filter((a) => isActionOpen(a.status)).slice(0, MAX_LIST_ITEMS).map((a) => {
    addRef(a.action_ref);
    return { ref: a.action_ref, description: truncate(a.description), owner: a.owner ?? null, dueDate: a.due_date };
  });

  const openDecisions = scoped.decisions.filter((d) => isDecisionOpen(d.status)).slice(0, MAX_LIST_ITEMS).map((d) => {
    addRef(d.decision_ref);
    return { ref: d.decision_ref, question: truncate(d.question), owner: d.owner ?? null, dueDate: d.due_date };
  });

  const openDependencies = scoped.dependencies.filter((d) => isDependencyOpen(d.status)).slice(0, MAX_DEPENDENCIES).map((d) => {
    addRef(d.name);
    return { name: truncate(d.name), owner: d.owner ?? null };
  });

  const failedOrBlockedTests = scoped.test_cases.filter((t) => isTestFailedOrBlocked(t.status)).slice(0, MAX_LIST_ITEMS).map((t) => {
    addRef(t.test_ref);
    return { ref: t.test_ref, scenario: truncate(t.scenario), status: t.status };
  });

  const requirementRefById = new Map(scoped.requirements.map((r) => [r.id, r.requirement_ref]));
  const outstandingAcceptanceCriteria = (scoped.acceptance_criteria ?? [])
    .filter((ac) => isAcceptanceCriteriaOutstanding(ac.status))
    .slice(0, MAX_LIST_ITEMS)
    .map((ac) => {
      addRef(ac.ac_ref);
      const requirementRef = requirementRefById.get(ac.requirement_id) ?? null;
      addRef(requirementRef);
      return { ref: ac.ac_ref, criterion: truncate(ac.criterion), status: ac.status, requirementRef };
    });

  const customerOwnedItems = buildCustomerOwnedItems(scoped.go_live_checklists ?? [], state.project.customer);
  customerOwnedItems.forEach((item) => addRef(item.ref));

  const scheduleEvidence = {
    upcomingMilestones: buildUpcomingMilestones(scoped.milestones),
    activeTimelineItems: buildActiveTimelineItems(state.schedule.blocked, state.schedule.atRisk, state.schedule.active),
  };
  scheduleEvidence.upcomingMilestones.forEach((m) => addRef(m.ref));

  const goLiveReadiness = {
    status: state.goLive.status,
    readinessPercent: state.goLive.readinessPercent,
    checks: state.goLive.checks.map((c) => ({
      key: c.key,
      label: c.label,
      source: c.source,
      effective: c.effective,
      derived: c.derived,
      override: c.override
        ? { status: c.override.status, reason: truncate(c.override.reason), by: c.override.by, at: c.override.at }
        : null,
    })),
  };

  return {
    generatedAt: state.generatedAt.toISOString(),
    project: {
      name: state.project.name,
      customer: state.project.customer,
      workstream: state.project.workstream,
      status: state.project.status,
    },
    phase: {
      phase: state.phase.phase,
      confidence: state.phase.confidence,
      source: state.phase.source,
      detail: truncate(state.phase.detail),
    },
    schedule: {
      health: state.schedule.health,
      variance: state.schedule.variance,
      daysRemaining: state.schedule.daysRemaining,
      projectStart: state.schedule.projectStart,
      projectEnd: state.schedule.projectEnd,
    },
    goLiveDate: {
      date: state.goLiveDate.date,
      source: state.goLiveDate.source,
      milestoneTitle: state.goLiveDate.milestoneTitle,
    },
    // Projects ManagerProjectSummary (lib/manager-summary.ts) — the one
    // place "project health" already comes with a plain-English summary,
    // an attention-required call-out, and a management-action verdict,
    // rather than the bare RagStatus ProjectState.projectHealth carries.
    projectHealth: {
      status: state.managerSummary.status,
      summary: truncate(state.managerSummary.summary, 400),
      attentionRequired: state.managerSummary.attentionRequired ? truncate(state.managerSummary.attentionRequired, 400) : null,
      dateConfidence: state.managerSummary.dateConfidence,
      managementAction: state.managerSummary.managementAction,
    },
    deliveryConfidence: {
      score: state.confidence.score,
      rag: state.confidence.rag,
      reasons: state.confidence.reasons.slice(0, MAX_REASONS).map((r) => truncate(r, 200)),
    },
    goLiveReadiness,
    rollups: state.rollups,
    recommendations,
    openRisks,
    openActions,
    openDecisions,
    openDependencies,
    failedOrBlockedTests,
    outstandingAcceptanceCriteria,
    customerOwnedItems,
    scheduleEvidence,
    sourceRefs: [...refs],
  };
}
