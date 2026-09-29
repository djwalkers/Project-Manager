import { workerAnalysisClaim } from "@/lib/requirement-analysis-server";
import { workerRoute } from "@/lib/worker-route";

// POST /api/worker/analysis/claim — local worker only (worker token).
export const POST = workerRoute(workerAnalysisClaim);
