import { NextRequest, NextResponse } from "next/server";
import { requireCanRunRequirementAnalysis, requireCanViewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { getRequirementTestGeneration, getTestGenerationRun, queueTestGeneration } from "@/lib/test-generation-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/requirements/test-generation?project_id=&requirement_id= — Manager/Admin:
// eligibility, the Requirement's canonical ACs and its test generation runs.
// GET /api/requirements/test-generation?project_id=&run_id= — Manager/Admin: one
// run with its proposed (non-canonical) test cases, issues and source fragments.
export async function GET(req: NextRequest) {
  const denied = await requireCanViewRequirementAnalysis();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  const result = p.get("run_id")
    ? await getTestGenerationRun(db, p.get("project_id") ?? "", p.get("run_id") ?? "")
    : await getRequirementTestGeneration(db, p.get("project_id") ?? "", p.get("requirement_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

// POST /api/requirements/test-generation — Manager/Admin: queue test generation
// for a Requirement ({ project_id, requirement_id, ac_ids? }) or retry a failed
// run ({ ..., retry_of_run_id }). Runs on the local worker's Ollama.
export async function POST(req: NextRequest) {
  const denied = await requireCanRunRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await queueTestGeneration(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
