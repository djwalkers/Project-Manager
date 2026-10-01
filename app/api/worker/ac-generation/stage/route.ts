import { workerAcGenerationStage } from "@/lib/ac-generation-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/ac-generation/stage — local worker only (worker token).
export const POST = workerRoute(workerAcGenerationStage);
