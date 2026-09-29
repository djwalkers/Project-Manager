import { NextRequest, NextResponse } from "next/server";
import { requireCanRunRequirementAnalysis, requireCanViewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { listAnalysisRuns, queueAnalysis } from "@/lib/requirement-analysis-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/source-documents/analysis?project_id= — Manager/Admin: the
// project's analysis runs with counts (no proposal content).
export async function GET(req: NextRequest) {
  const denied = await requireCanViewRequirementAnalysis();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await listAnalysisRuns(db, req.nextUrl.searchParams.get("project_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

// POST /api/source-documents/analysis — Manager/Admin: queue analysis of a
// version's newest completed extraction, or retry a failed run
// ({ retry_of_run_id }). Runs locally on the worker's Ollama.
export async function POST(req: NextRequest) {
  const denied = await requireCanRunRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await queueAnalysis(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
