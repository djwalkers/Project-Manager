import { workerFail } from "@/lib/extraction-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/fail — local extraction worker only (worker token).
export const POST = workerRoute(workerFail);
