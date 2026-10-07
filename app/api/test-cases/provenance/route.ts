import { NextRequest, NextResponse } from "next/server";
import { requireCanReadProjectData } from "@/lib/api-auth";
import { testCaseProvenance } from "@/lib/test-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/test-cases/provenance?project_id=&test_id= — any valid role: a
// canonical test's structure, where a promoted test came from (proposal, run,
// the ACs as approved, their provenance, Requirement, source) and whether its
// source ACs changed since promotion. No working AI content.
// { provenance: null } for a manually created test.
export async function GET(req: NextRequest) {
  const denied = await requireCanReadProjectData();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  const result = await testCaseProvenance(db, p.get("project_id") ?? "", p.get("test_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
