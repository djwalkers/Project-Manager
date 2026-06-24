import { parseScheduleDate } from "@/lib/schedule";
import type { Deliverable, ProjectSnapshot } from "@/lib/types";

const DAY_MS = 86_400_000;

export type DeliverableAttention = {
  id: string;
  deliverable: Deliverable;
  severity: "Critical" | "Warning";
  reason: string;
  recommendation: string;
};

function todayUtc(now: Date) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

export function deliverableDaysUntil(value: string | null, now = new Date()) {
  const date = parseScheduleDate(value);
  return date ? Math.ceil((date.getTime() - todayUtc(now)) / DAY_MS) : null;
}

export function isDeliverableComplete(item: Deliverable) {
  return item.status === "Deployed" || item.deployment_status === "Deployed";
}

export function isDevelopmentComplete(item: Deliverable) {
  return ["Complete", "Ready for SIT", "SIT Complete", "Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"].includes(item.development_status)
    || ["Ready for SIT", "SIT Complete", "Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"].includes(item.status);
}

export function isSitComplete(item: Deliverable) {
  return ["Complete", "Passed", "SIT Complete", "Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"].includes(item.sit_status)
    || ["SIT Complete", "Ready for UAT", "UAT Complete", "Ready for Deployment", "Deployed"].includes(item.status);
}

export function isUatComplete(item: Deliverable) {
  return ["Complete", "Passed", "UAT Complete", "Ready for Deployment", "Deployed"].includes(item.uat_status)
    || ["UAT Complete", "Ready for Deployment", "Deployed"].includes(item.status);
}

export function calculateDeliveryReadiness(deliverables: Deliverable[]) {
  const completed = deliverables.filter(isDeliverableComplete).length;
  return { completed, total: deliverables.length, percent: deliverables.length ? Math.round((completed / deliverables.length) * 100) : 0 };
}

export function deliverablesRequiringAttention(deliverables: Deliverable[], now = new Date()): DeliverableAttention[] {
  const candidates: DeliverableAttention[] = [];
  deliverables.forEach((item) => {
    const days = deliverableDaysUntil(item.planned_completion_date, now);
    if (item.status === "Blocked" || [item.development_status, item.sit_status, item.uat_status, item.deployment_status].includes("Blocked")) {
      candidates.push({ id: `${item.id}-blocked`, deliverable: item, severity: "Critical", reason: "Deliverable is blocked", recommendation: `Resolve the blocker and replan ${item.deliverable_ref}.` });
    } else if (!isDeliverableComplete(item) && days !== null && days < 0) {
      candidates.push({ id: `${item.id}-overdue`, deliverable: item, severity: "Critical", reason: `Planned completion is ${Math.abs(days)} days overdue`, recommendation: `Agree a recovery date for ${item.deliverable_ref}.` });
    } else if (!isDeliverableComplete(item) && days !== null && days <= 7) {
      candidates.push({ id: `${item.id}-approaching`, deliverable: item, severity: "Warning", reason: `Planned completion is due in ${days} days`, recommendation: `Confirm completion readiness for ${item.deliverable_ref}.` });
    }
    if (["Ready for SIT", "SIT Complete"].includes(item.status) && !isDevelopmentComplete(item)) candidates.push({ id: `${item.id}-sit`, deliverable: item, severity: "Critical", reason: "SIT is due but development is incomplete", recommendation: `Complete development evidence before ${item.deliverable_ref} enters SIT.` });
    if (["Ready for UAT", "UAT Complete"].includes(item.status) && !isSitComplete(item)) candidates.push({ id: `${item.id}-uat`, deliverable: item, severity: "Critical", reason: "UAT is due but SIT is incomplete", recommendation: `Complete SIT evidence before ${item.deliverable_ref} enters UAT.` });
    if (["Ready for Deployment", "Deployed"].includes(item.status) && !isUatComplete(item)) candidates.push({ id: `${item.id}-deployment`, deliverable: item, severity: "Critical", reason: "Deployment readiness is missing UAT completion", recommendation: `Confirm UAT sign-off before deploying ${item.deliverable_ref}.` });
  });
  return candidates.sort((a, b) => Number(b.severity === "Critical") - Number(a.severity === "Critical") || String(a.deliverable.planned_completion_date).localeCompare(String(b.deliverable.planned_completion_date)));
}

export function buildDeliverableCompletionTrend(deliverables: Deliverable[], snapshots: ProjectSnapshot[], now = new Date()) {
  const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dates = Array.from(new Set([...snapshots.map((item) => item.snapshot_date), currentDate])).sort();
  return dates.map((date) => ({
    date,
    value: deliverables.filter((item) => {
      if (!isDeliverableComplete(item)) return false;
      const completedDate = item.actual_completion_date ?? item.updated_at.slice(0, 10);
      return completedDate <= date;
    }).length,
  }));
}

