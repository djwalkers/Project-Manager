import { workerAcGenerationFail } from "@/lib/ac-generation-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/ac-generation/fail — local worker only (worker token).
export const POST = workerRoute(workerAcGenerationFail);
