import { workerComplete } from "@/lib/extraction-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/complete — local extraction worker only (worker token).
export const POST = workerRoute(workerComplete);
