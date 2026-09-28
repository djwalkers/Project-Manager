import { workerAddFragments } from "@/lib/extraction-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/fragments — local extraction worker only (worker token).
export const POST = workerRoute(workerAddFragments);
