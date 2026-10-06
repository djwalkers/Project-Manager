import { NextRequest, NextResponse } from "next/server";
import { requireCanReadProjectData } from "@/lib/api-auth";
import { acProvenance } from "@/lib/ac-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/acceptance-criteria/provenance?project_id=&ac_id= — any valid role:
// where a promoted canonical AC came from (proposal, run, Requirement, source
// fragments, Human Clarifications, scope notes, resolved issues). No working
// AI content. { provenance: null } for a manually created AC.
export async function GET(req: NextRequest) {
  const denied = await requireCanReadProjectData();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  const result = await acProvenance(db, p.get("project_id") ?? "", p.get("ac_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
