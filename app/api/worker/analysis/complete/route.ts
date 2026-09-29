import { workerAnalysisComplete } from "@/lib/requirement-analysis-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/analysis/complete — local worker only (worker token).
export const POST = workerRoute(workerAnalysisComplete);
