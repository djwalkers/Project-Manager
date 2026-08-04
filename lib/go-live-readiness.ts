import type { DataStore } from "@/lib/data-store";
import { isDevelopmentComplete, isSitComplete, isUatComplete } from "@/lib/delivery";
import {
  isAcceptanceCriteriaMet,
  isDecisionOpen,
  isDeliverableComplete,
  isRequirementSignedOff,
  isRiskClosed,
  isRiskHighOrCritical,
  isRiskOpen,
  isTestPassed,
} from "@/lib/lifecycle";
import { deriveProjectPhase, isPhaseAtOrAfter, MANUAL_CHECK_APPLICABLE_FROM, type ManualCheckKey, type ProjectPhase } from "@/lib/project-phase";
import { resolveGoLiveDate } from "@/lib/project-dates";
import type {
  AcceptanceCriteria,
  Deliverable,
  GoLiveChecklist,
  GoLiveChecklistCategory,
  GoLiveReadinessOverride,
  GoLiveReadinessOverrideStatus,
  Project,
} from "@/lib/types";
import { scopeProjectData } from "@/lib/project-scope";

// ── Readiness model (Phase 6) ───────────────────────────────────────────────
//
// 12 checks: 7 auto-derived from lifecycle data, 5 manual (checklist-backed,
// phase-gated). Five possible statuses per check:
//   - Complete / Incomplete / Waived  — a real, assessed outcome
//   - Not Yet Assessed                — an auto check with no applicable
//                                        records yet (not a pass, not a fail)
//   - Not Yet Required                — a manual check whose gating phase
//                                        hasn't been reached yet
// Not Yet Assessed and Not Yet Required are both excluded from the
// readiness percentage denominator. If every check falls into one of those
// two states, the overall status is "Not Assessed" — never a 0%/Red result
// forced by simply having no data yet (the defect this phase fixes).

export type ReadinessCheckStatus = "Complete" | "Incomplete" | "Waived" | "Not Yet Assessed" | "Not Yet Required";
export type GoLiveStatus = "Green" | "Amber" | "Red" | "Not Assessed";

export type AutoCheckKey =
  | "requirements_signed_off"
  | "development_complete"
  | "sit_complete"
  | "uat_signed_off"
  | "acceptance_criteria_met"
  | "risks_closed"
  | "tests_passed";

// The 7 auto-derived checks are the only ones a manual override can target
// — manual checks are already user-editable directly via go_live_checklists.
export const GO_LIVE_OVERRIDABLE_CHECK_KEYS: readonly AutoCheckKey[] = [
  "requirements_signed_off",
  "development_complete",
  "sit_complete",
  "uat_signed_off",
  "acceptance_criteria_met",
  "risks_closed",
  "tests_passed",
];

// Overrides never carry the two structural states (Not Yet Assessed / Not
// Yet Required) — those describe "nothing to grade yet", not a human
// decision, so they are not valid things to override to. Validated
// server-side in app/api/go-live/overrides/route.ts.
export const GO_LIVE_OVERRIDE_STATUSES: readonly GoLiveReadinessOverrideStatus[] = ["Complete", "Incomplete", "Waived"];

export type ReadinessOverrideView = { status: ReadinessCheckStatus; reason: string; by: string; at: string };

export type ReadinessCheckResult = {
  key: string;
  label: string;
  source: "Auto" | "Manual";
  derived: ReadinessCheckStatus;
  override: ReadinessOverrideView | null;
  effective: ReadinessCheckStatus;
  checklistItem: GoLiveChecklist | null;
};

export type GoLiveDashboard = {
  project: Project;
  status: GoLiveStatus;
  readinessPercent: number;
  completedItems: number;
  totalItems: number;
  excludedCount: number;
  incompleteCount: number;
  blockerCount: number;
  openRisks: number;
  openCriticalRisks: number;
  outstandingDecisions: number;
  outstandingDeliverables: number;
  outstandingTesting: number;
  checks: ReadinessCheckResult[];
  hasGoLiveDate: boolean;
  goLiveDate: string | null;
  daysToGoLive: number | null;
};

const AUTO_CHECKS: Array<{ key: AutoCheckKey; label: string }> = [
  { key: "requirements_signed_off", label: "Requirements Signed Off" },
  { key: "development_complete", label: "Development Complete" },
  { key: "sit_complete", label: "SIT Complete" },
  { key: "uat_signed_off", label: "UAT Signed Off" },
  { key: "acceptance_criteria_met", label: "Acceptance Criteria Met" },
  { key: "risks_closed", label: "Risks Closed" },
  { key: "tests_passed", label: "Tests Passed" },
];

// category/matchItem give a documented compatibility mapping for legacy
// go_live_checklists rows: exact category match is tried first (the primary,
// non-fuzzy path); matchItem substring matching is only a fallback for
// legacy rows that predate consistent categorisation.
// warehouse_training was removed here (post-audit Phase 1) — customer
// operational/organisational readiness (e.g. warehouse staff training) is
// out of scope for this provider software-delivery tool. A historical
// go_live_checklists row with category "Training" is left in storage
// untouched, but no check below matches it any longer, so it can never
// affect the readiness percentage, RAG, or any consumer of this dashboard.
const MANUAL_CHECKS: Array<{ key: ManualCheckKey; label: string; category: GoLiveChecklistCategory; matchItem: string }> = [
  { key: "customer_approval", label: "Customer Approval", category: "Customer Approval", matchItem: "customer" },
  { key: "deployment_cutover_approval", label: "Deployment / Cutover Approval", category: "Deployment", matchItem: "deployment" },
  { key: "rollback_plan_approved", label: "Rollback Plan Approved", category: "Rollback", matchItem: "rollback" },
  { key: "hypercare_owner_assigned", label: "Hypercare Owner Assigned", category: "Hypercare", matchItem: "hypercare" },
  { key: "support_rota_confirmed", label: "Support Rota Confirmed", category: "Support", matchItem: "support" },
];

export const GO_LIVE_CATEGORIES: GoLiveChecklistCategory[] = [
  "Requirements", "Development", "SIT", "UAT", "Data",
  "Deployment", "Hypercare", "Rollback", "Support", "Customer Approval",
];

export const GO_LIVE_CHECKLIST_STATUSES = ["Not Started", "In Progress", "Complete", "Blocked", "Waived"] as const;
export const CUTOVER_STEP_STATUSES = ["Not Started", "In Progress", "Complete", "Blocked", "Skipped"] as const;

function daysUntil(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

const SIT_OR_LATER_STATUSES = ["Ready for SIT", "SIT Complete", "Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"];
const UAT_OR_LATER_STATUSES = ["Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"];

// "Evidence" distinguishes "hasn't reached this stage yet" (Not Yet
// Assessed) from "reached this stage and hasn't passed it" (Incomplete).
function hasSitEvidence(item: Deliverable) {
  return item.sit_status !== "Not Started" || SIT_OR_LATER_STATUSES.includes(item.status);
}
function hasUatEvidence(item: Deliverable) {
  return item.uat_status !== "Not Started" || UAT_OR_LATER_STATUSES.includes(item.status);
}

function resolveAutoCheck(key: AutoCheckKey, scoped: DataStore, scopedAC: AcceptanceCriteria[], phase: ProjectPhase): ReadinessCheckStatus {
  switch (key) {
    case "requirements_signed_off":
      if (scoped.requirements.length === 0) return "Not Yet Assessed";
      return scoped.requirements.every((r) => isRequirementSignedOff(r.status)) ? "Complete" : "Incomplete";
    case "development_complete":
      if (scoped.deliverables.length === 0) return "Not Yet Assessed";
      return scoped.deliverables.every(isDevelopmentComplete) ? "Complete" : "Incomplete";
    case "sit_complete": {
      // Post-Phase-7 defect fix: the derived project phase already
      // synthesises timeline/milestone/deliverable/test evidence with a
      // sensible priority (see lib/project-phase.ts). Once the project has
      // genuinely moved on to UAT or later, SIT cannot still be
      // outstanding by definition — checked first so a deliverable's own
      // sit_status sub-field (which real projects don't always keep in
      // sync once the team has moved on) can no longer read this check as
      // Incomplete despite SIT having demonstrably finished.
      if (isPhaseAtOrAfter(phase, "UAT")) return "Complete";
      if (scoped.deliverables.length === 0 || !scoped.deliverables.some(hasSitEvidence)) return "Not Yet Assessed";
      return scoped.deliverables.every(isSitComplete) ? "Complete" : "Incomplete";
    }
    case "uat_signed_off":
      if (scoped.deliverables.length === 0 || !scoped.deliverables.some(hasUatEvidence)) return "Not Yet Assessed";
      return scoped.deliverables.every(isUatComplete) ? "Complete" : "Incomplete";
    case "acceptance_criteria_met":
      if (scopedAC.length === 0) return "Not Yet Assessed";
      return scopedAC.every((ac) => isAcceptanceCriteriaMet(ac.status)) ? "Complete" : "Incomplete";
    case "risks_closed":
      if (scoped.risks.length === 0) return "Not Yet Assessed";
      return scoped.risks.every((r) => isRiskClosed(r.status)) ? "Complete" : "Incomplete";
    case "tests_passed":
      if (scoped.test_cases.length === 0) return "Not Yet Assessed";
      return scoped.test_cases.every((t) => isTestPassed(t.status)) ? "Complete" : "Incomplete";
  }
}

function findChecklistMatch(checklists: GoLiveChecklist[], def: { category: GoLiveChecklistCategory; matchItem: string }): GoLiveChecklist | null {
  const exact = checklists.filter((c) => c.category === def.category);
  const pool = exact.length ? exact : checklists.filter((c) => c.item.toLowerCase().includes(def.matchItem));
  if (!pool.length) return null;
  return [...pool].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function resolveManualCheck(
  def: { key: ManualCheckKey; category: GoLiveChecklistCategory; matchItem: string },
  checklists: GoLiveChecklist[],
  phase: ProjectPhase,
): { status: ReadinessCheckStatus; match: GoLiveChecklist | null; blocked: boolean } {
  const applicable = isPhaseAtOrAfter(phase, MANUAL_CHECK_APPLICABLE_FROM[def.key]);
  const match = findChecklistMatch(checklists, def);
  if (!applicable) return { status: "Not Yet Required", match, blocked: false };
  if (!match) return { status: "Incomplete", match: null, blocked: false };
  if (match.status === "Complete") return { status: "Complete", match, blocked: false };
  if (match.status === "Waived") return { status: "Waived", match, blocked: false };
  return { status: "Incomplete", match, blocked: match.status === "Blocked" };
}

// Overrides are unique per (project_id, check_key) in the database, but a
// local-mode (no Supabase configured) create can add a second row for the
// same check without an upsert. Picking the latest by overridden_at keeps
// resolution correct regardless of storage mode.
function latestOverrideByKey(overrides: GoLiveReadinessOverride[]): Map<string, GoLiveReadinessOverride> {
  const byKey = new Map<string, GoLiveReadinessOverride>();
  for (const override of overrides) {
    const current = byKey.get(override.check_key);
    if (!current || override.overridden_at > current.overridden_at) byKey.set(override.check_key, override);
  }
  return byKey;
}

function applyOverride(derived: ReadinessCheckStatus, override: GoLiveReadinessOverride | undefined): { effective: ReadinessCheckStatus; override: ReadinessOverrideView | null } {
  if (!override) return { effective: derived, override: null };
  return {
    effective: override.override_status,
    override: { status: override.override_status, reason: override.override_reason, by: override.overridden_by, at: override.overridden_at },
  };
}

export function buildGoLiveDashboard(data: DataStore, project: Project, now = new Date()): GoLiveDashboard {
  const scoped = scopeProjectData(data, project);
  const scopedAC = (data.acceptance_criteria ?? []).filter((ac) => ac.project_id === project.id);
  const checklists = (data.go_live_checklists ?? []).filter((c) => c.project_id === project.id);
  const overrideByKey = latestOverrideByKey((data.go_live_readiness_overrides ?? []).filter((o) => o.project_id === project.id));
  const phase = deriveProjectPhase(data, project, now).phase;

  const autoChecks: ReadinessCheckResult[] = AUTO_CHECKS.map((def) => {
    const derived = resolveAutoCheck(def.key, scoped, scopedAC, phase);
    const { effective, override } = applyOverride(derived, overrideByKey.get(def.key));
    return { key: def.key, label: def.label, source: "Auto", derived, override, effective, checklistItem: null };
  });

  let blockerCount = 0;
  const manualChecks: ReadinessCheckResult[] = MANUAL_CHECKS.map((def) => {
    const { status, match, blocked } = resolveManualCheck(def, checklists, phase);
    if (blocked) blockerCount += 1;
    return { key: def.key, label: def.label, source: "Manual", derived: status, override: null, effective: status, checklistItem: match };
  });

  const checks = [...autoChecks, ...manualChecks];
  const assessed = checks.filter((c) => c.effective !== "Not Yet Assessed" && c.effective !== "Not Yet Required");
  const passed = assessed.filter((c) => c.effective === "Complete" || c.effective === "Waived");
  const readinessPercent = assessed.length === 0 ? 0 : Math.round((passed.length / assessed.length) * 100);
  const excludedCount = checks.length - assessed.length;
  const incompleteCount = assessed.length - passed.length;

  const openRisks = scoped.risks.filter((r) => isRiskOpen(r.status)).length;
  const openCriticalRisks = scoped.risks.filter((r) => isRiskOpen(r.status) && isRiskHighOrCritical(r.impact)).length;
  const outstandingDecisions = scoped.decisions.filter((d) => isDecisionOpen(d.status)).length;
  const outstandingDeliverables = scoped.deliverables.filter((d) => !isDeliverableComplete(d)).length;
  const outstandingTesting = scoped.test_cases.filter((t) => !["Passed", "Blocked"].includes(t.status)).length;

  const goLiveDate = resolveGoLiveDate(data, project).date;
  const daysToGoLive = daysUntil(goLiveDate, now);

  // RAG thresholds (Phase 6, replacing the old fixed 80%/95% checklist-row
  // thresholds): Red requires a concrete blocker — a manual check marked
  // Blocked, an open critical risk, or readiness below 60% once something
  // has actually been assessed. Amber covers any shortfall short of 100%
  // that isn't one of those blockers. Not Assessed applies only when there
  // is nothing to grade yet (every check is Not Yet Assessed/Not Yet
  // Required) — this is what replaces the old "empty checklist ⇒ 0% Red".
  let status: GoLiveStatus;
  if (assessed.length === 0) status = "Not Assessed";
  else if (blockerCount > 0 || openCriticalRisks > 0 || readinessPercent < 60) status = "Red";
  else if (readinessPercent < 100) status = "Amber";
  else status = "Green";

  return {
    project,
    status,
    readinessPercent,
    completedItems: passed.length,
    totalItems: assessed.length,
    excludedCount,
    incompleteCount,
    blockerCount,
    openRisks,
    openCriticalRisks,
    outstandingDecisions,
    outstandingDeliverables,
    outstandingTesting,
    checks,
    hasGoLiveDate: Boolean(goLiveDate),
    goLiveDate,
    daysToGoLive,
  };
}
