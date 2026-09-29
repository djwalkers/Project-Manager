import { NextRequest, NextResponse } from "next/server";
import { requireCanViewRequirementAnalysis } from "@/lib/api-auth";
import { getAnalysisRun } from "@/lib/requirement-analysis-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/analysis/runs?project_id=&run_id= — Manager/Admin: one analysis
// run with its proposals, issues and the analysed fragments (provenance).
export async function GET(req: NextRequest) {
  const denied = await requireCanViewRequirementAnalysis();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const params = req.nextUrl.searchParams;
  const result = await getAnalysisRun(db, params.get("project_id") ?? "", params.get("run_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
