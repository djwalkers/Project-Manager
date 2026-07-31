import { normaliseStatus } from "@/lib/lifecycle/shared";
import type { Deliverable } from "@/lib/types";

export { isDeliverableComplete, isDevelopmentComplete, isSitComplete, isUatComplete } from "@/lib/delivery";

export function isDeliverableBlocked(
  item: Pick<Deliverable, "status" | "development_status" | "sit_status" | "uat_status" | "deployment_status">,
): boolean {
  const subStatuses = [item.development_status, item.sit_status, item.uat_status, item.deployment_status];
  return normaliseStatus(item.status) === "blocked" || subStatuses.some((value) => normaliseStatus(value) === "blocked");
}
