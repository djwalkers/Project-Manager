import { NextRequest, NextResponse } from "next/server";
import { requireCanRunRequirementAnalysis, requireCanViewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { getAcGenerationRun, getRequirementAcGeneration, queueAcGeneration } from "@/lib/ac-generation-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/requirements/ac-generation?project_id=&requirement_id= — Manager/Admin:
// eligibility and the generation runs of one Requirement.
// GET /api/requirements/ac-generation?project_id=&run_id= — Manager/Admin: one
// run with its generated (non-canonical) criteria, issues and source fragments.
export async function GET(req: NextRequest) {
  const denied = await requireCanViewRequirementAnalysis();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  const result = p.get("run_id")
    ? await getAcGenerationRun(db, p.get("project_id") ?? "", p.get("run_id") ?? "")
    : await getRequirementAcGeneration(db, p.get("project_id") ?? "", p.get("requirement_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

// POST /api/requirements/ac-generation — Manager/Admin: queue generation for an
// eligible promoted Requirement ({ project_id, requirement_id }), or retry a
// failed run ({ ..., retry_of_run_id }). Runs on the local worker's Ollama.
export async function POST(req: NextRequest) {
  const denied = await requireCanRunRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await queueAcGeneration(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
