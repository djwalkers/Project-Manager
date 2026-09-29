import { workerAnalysisStage } from "@/lib/requirement-analysis-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/analysis/stage — local worker only (worker token).
export const POST = workerRoute(workerAnalysisStage);
