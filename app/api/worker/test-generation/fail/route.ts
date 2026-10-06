import { workerTestGenerationFail } from "@/lib/test-generation-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/test-generation/fail — local worker only (worker token).
export const POST = workerRoute(workerTestGenerationFail);
