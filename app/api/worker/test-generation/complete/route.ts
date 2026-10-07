import { workerTestGenerationComplete } from "@/lib/test-generation-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/test-generation/complete — local worker only (worker token).
export const POST = workerRoute(workerTestGenerationComplete);
