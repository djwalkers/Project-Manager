import { workerHeartbeat } from "@/lib/extraction-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/heartbeat — local extraction worker only (worker token).
export const POST = workerRoute(workerHeartbeat);
