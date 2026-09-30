import { NextRequest, NextResponse } from "next/server";
import { requireCanReadProjectData } from "@/lib/api-auth";
import { requirementProvenance } from "@/lib/requirement-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/requirements/provenance?project_id=&requirement_id= — any valid
// role: the source document, version, sections, pages and fragment text a
// promoted Requirement came from (no other analysis/proposal content).
export async function GET(req: NextRequest) {
  const denied = await requireCanReadProjectData();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  const result = await requirementProvenance(db, p.get("project_id") ?? "", p.get("requirement_id") ?? "");
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
