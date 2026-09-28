import { workerClaim } from "@/lib/extraction-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/claim — local extraction worker only (worker token).
export const POST = workerRoute(workerClaim);
