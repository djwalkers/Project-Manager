import { workerAcGenerationClaim } from "@/lib/ac-generation-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/ac-generation/claim — local worker only (worker token).
export const POST = workerRoute(workerAcGenerationClaim);
