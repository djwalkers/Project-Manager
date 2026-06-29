import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectActiveProject } from "@/lib/project-scope";

export type DeliveryConfidenceResult = {
  score: number;
  reasons: string[];
  rag: "Green" | "Amber" | "Red";
};

export function computeDeliveryConfidence(data: DataStore): DeliveryConfidenceResult {
  const project = selectActiveProject(data);
  if (!project) return { score: 0, reasons: ["No active project"], rag: "Red" };

  const scoped = scopeProjectData(data, project);

  let score = 100;
  const reasons: string[] = [];

  const todayStr = new Date().toISOString().slice(0, 10);

  // Blocked actions: -5 each, max -25
  const blockedActions = scoped.actions.filter((a) => a.status === "Blocked").length;
  if (blockedActions > 0) {
    score -= Math.min(blockedActions * 5, 25);
    reasons.push(`${blockedActions} blocked action${blockedActions > 1 ? "s" : ""}`);
  }

  // Open queries (unanswered): -3 each, max -20
  const openQueries = scoped.discovery_questions.filter(
    (q) => !["Answered", "Closed"].includes(q.status),
  ).length;
  if (openQueries > 0) {
    score -= Math.min(openQueries * 3, 20);
    reasons.push(`${openQueries} unanswered ${openQueries === 1 ? "query" : "queries"}`);
  }

  // High / critical risks: -4 each, max -20
  const highRisks = scoped.risks.filter(
    (r) => ["High", "Critical"].includes(r.impact) && !["Complete", "Closed"].includes(r.status),
  ).length;
  if (highRisks > 0) {
    score -= Math.min(highRisks * 4, 20);
    reasons.push(`${highRisks} high ${highRisks === 1 ? "risk" : "risks"}`);
  }

  // Failed acceptance criteria: -3 each, max -15
  const allAC = scoped.acceptance_criteria ?? [];
  const failedAC = allAC.filter((ac) => ac.status === "Failed").length;
  if (failedAC > 0) {
    score -= Math.min(failedAC * 3, 15);
    reasons.push(`${failedAC} failed acceptance ${failedAC === 1 ? "criterion" : "criteria"}`);
  }

  // AC missing evidence (>50% without any): -10
  if (allAC.length > 0) {
    const allEvidence = scoped.evidence ?? [];
    const acWithEvidence = allAC.filter((ac) =>
      allEvidence.some((ev) => ev.ac_id === ac.id),
    ).length;
    if (acWithEvidence / allAC.length < 0.5) {
      const missing = allAC.length - acWithEvidence;
      score -= 10;
      reasons.push(`${missing} acceptance ${missing === 1 ? "criterion" : "criteria"} missing evidence`);
    }
  }

  // Pending sign-offs: -3 each, max -12
  const pendingSignOffs = (scoped.requirement_sign_offs ?? []).filter(
    (s) => s.status === "Pending",
  ).length;
  if (pendingSignOffs > 0) {
    score -= Math.min(pendingSignOffs * 3, 12);
    reasons.push(`${pendingSignOffs} pending sign-off${pendingSignOffs > 1 ? "s" : ""}`);
  }

  // Open decisions: -2 each, max -10
  const openDecisions = scoped.decisions.filter(
    (d) => !["Approved", "Closed"].includes(d.status),
  ).length;
  if (openDecisions > 0) {
    score -= Math.min(openDecisions * 2, 10);
    reasons.push(`${openDecisions} open ${openDecisions === 1 ? "decision" : "decisions"}`);
  }

  // Outstanding dependencies: -2 each, max -10
  const outstandingDeps = scoped.dependencies.filter(
    (d) => !["Complete", "Closed"].includes(d.status),
  ).length;
  if (outstandingDeps > 0) {
    score -= Math.min(outstandingDeps * 2, 10);
    reasons.push(
      `${outstandingDeps} outstanding ${outstandingDeps === 1 ? "dependency" : "dependencies"}`,
    );
  }

  // Upcoming critical milestone within 7 days
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const in7Str = in7.toISOString().slice(0, 10);
  const urgentMilestones = scoped.milestones.filter(
    (m) =>
      m.target_date &&
      m.target_date >= todayStr &&
      m.target_date <= in7Str &&
      !["Complete", "Closed"].includes(m.status),
  );
  if (urgentMilestones.length > 0) {
    const name = urgentMilestones[0].title;
    reasons.push(`${name} begins in ≤7 days`);
  }

  const final = Math.max(0, Math.min(100, score));
  const rag: "Green" | "Amber" | "Red" =
    final >= 70 ? "Green" : final >= 40 ? "Amber" : "Red";

  return { score: final, reasons, rag };
}
