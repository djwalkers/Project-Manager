import type { DataStore } from "@/lib/data-store";

export type RecommendationType =
  | "action"
  | "risk"
  | "decision"
  | "milestone"
  | "question"
  | "meeting"
  | "intelligence";

export type RecommendationUrgency = "critical" | "high" | "medium" | "low";

export type Recommendation = {
  id: string;
  type: RecommendationType;
  urgency: RecommendationUrgency;
  title: string;
  reason: string;
  href: string;
  score: number;
  ref?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - today().getTime()) / DAY_MS);
}

function daysOverdue(dateStr?: string | null): number {
  const d = daysUntil(dateStr);
  return d !== null && d < 0 ? Math.abs(d) : 0;
}

function plural(n: number, s: string, p = `${s}s`) {
  return `${n} ${n === 1 ? s : p}`;
}

export function buildRecommendations(data: DataStore, maxCount = 5): Recommendation[] {
  const recs: Recommendation[] = [];

  // ── Overdue actions ──────────────────────────────────────────────────────────
  const overdueActions = data.actions.filter(
    (a) => daysOverdue(a.due_date) > 0 && !["Complete", "Closed"].includes(a.status),
  );
  for (const a of overdueActions) {
    const n = daysOverdue(a.due_date);
    recs.push({
      id: `action-${a.id}`,
      type: "action",
      urgency: n > 7 ? "critical" : n > 3 ? "high" : "medium",
      title: `Complete overdue action: ${a.action_ref}`,
      reason: `"${a.description.slice(0, 80)}" is ${plural(n, "day")} overdue.`,
      href: "/actions",
      score: 100 + n * 5,
      ref: a.action_ref,
    });
  }

  // ── Blocked actions ───────────────────────────────────────────────────────────
  const blockedActions = data.actions.filter((a) => a.status === "Blocked");
  for (const a of blockedActions) {
    recs.push({
      id: `blocked-${a.id}`,
      type: "action",
      urgency: "high",
      title: `Unblock action: ${a.action_ref}`,
      reason: `"${a.description.slice(0, 80)}" is blocked and cannot progress.`,
      href: "/actions",
      score: 88,
      ref: a.action_ref,
    });
  }

  // ── Overdue decisions ────────────────────────────────────────────────────────
  const overdueDecisions = data.decisions.filter(
    (d) => daysOverdue(d.due_date) > 0 && !["Approved", "Closed"].includes(d.status),
  );
  for (const d of overdueDecisions) {
    const n = daysOverdue(d.due_date);
    recs.push({
      id: `decision-${d.id}`,
      type: "decision",
      urgency: n > 7 ? "high" : "medium",
      title: `Approve decision: ${d.decision_ref}`,
      reason: `"${d.question.slice(0, 80)}" is ${plural(n, "day")} past its deadline.`,
      href: "/decisions",
      score: 78 + n * 4,
      ref: d.decision_ref,
    });
  }

  // ── High/Critical risks without mitigation ───────────────────────────────────
  const unmitRisks = data.risks.filter(
    (r) =>
      ["High", "Critical"].includes(r.impact) &&
      !["Complete", "Closed"].includes(r.status) &&
      !r.mitigation?.trim(),
  );
  for (const r of unmitRisks) {
    recs.push({
      id: `risk-${r.id}`,
      type: "risk",
      urgency: r.impact === "Critical" ? "critical" : "high",
      title: `Review ${r.impact.toLowerCase()} risk: ${r.risk_ref}`,
      reason: `${r.impact}-impact risk has no mitigation plan: "${r.description.slice(0, 70)}".`,
      href: "/risks",
      score: r.impact === "Critical" ? 115 : 82,
      ref: r.risk_ref,
    });
  }

  // ── Milestones due within 7 days ─────────────────────────────────────────────
  const nearMilestones = data.milestones.filter((m) => {
    const d = daysUntil(m.target_date);
    return d !== null && d >= 0 && d <= 7 && !["Complete", "Closed"].includes(m.status);
  });
  for (const m of nearMilestones) {
    const d = daysUntil(m.target_date)!;
    const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
    recs.push({
      id: `milestone-${m.id}`,
      type: "milestone",
      urgency: d <= 1 ? "critical" : d <= 3 ? "high" : "medium",
      title: `Milestone due ${when}: ${m.milestone_ref}`,
      reason: `"${m.title}" is due ${when}. Current status: ${m.status}.`,
      href: "/milestones",
      score: 75 + (7 - d) * 5,
      ref: m.milestone_ref,
    });
  }

  // ── Discovery questions awaiting response ────────────────────────────────────
  const awaitingQueries = data.discovery_questions.filter((q) =>
    ["Awaiting Business", "Awaiting Development", "Awaiting Response"].includes(q.status),
  );
  if (awaitingQueries.length > 0) {
    recs.push({
      id: "queries-awaiting",
      type: "question",
      urgency: awaitingQueries.length >= 5 ? "high" : "medium",
      title: `Close ${plural(awaitingQueries.length, "discovery question")} awaiting response`,
      reason: `${plural(awaitingQueries.length, "question")} ${awaitingQueries.length === 1 ? "is" : "are"} awaiting a response and blocking progress.`,
      href: "/discovery-questions",
      score: 68 + awaitingQueries.length,
    });
  }

  // ── Pending meeting suggestions ──────────────────────────────────────────────
  const pendingSuggestions = (data.meeting_suggestions ?? []).filter(
    (s) => s.status === "Pending",
  );
  if (pendingSuggestions.length > 0) {
    recs.push({
      id: "meeting-intelligence-pending",
      type: "intelligence",
      urgency: "medium",
      title: `Review ${plural(pendingSuggestions.length, "meeting suggestion")}`,
      reason: `Meeting Intelligence has ${plural(pendingSuggestions.length, "unreviewed suggestion")} ready for your approval.`,
      href: "/meeting-intelligence",
      score: 65,
    });
  }

  // ── Blocked milestones ───────────────────────────────────────────────────────
  const blockedMilestones = data.milestones.filter((m) => m.status === "Blocked");
  for (const m of blockedMilestones) {
    recs.push({
      id: `milestone-blocked-${m.id}`,
      type: "milestone",
      urgency: "critical",
      title: `Unblock milestone: ${m.milestone_ref}`,
      reason: `"${m.title}" is blocked — this may delay downstream phases.`,
      href: "/milestones",
      score: 105,
      ref: m.milestone_ref,
    });
  }

  // Sort by score, deduplicate ids, take top N
  const seen = new Set<string>();
  return recs
    .sort((a, b) => b.score - a.score)
    .filter(({ id }) => (seen.has(id) ? false : seen.add(id) && true))
    .slice(0, maxCount);
}
