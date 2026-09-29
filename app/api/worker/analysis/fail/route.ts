import { workerAnalysisFail } from "@/lib/requirement-analysis-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/analysis/fail — local worker only (worker token).
export const POST = workerRoute(workerAnalysisFail);
