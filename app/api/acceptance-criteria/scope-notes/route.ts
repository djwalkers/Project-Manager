import { NextRequest, NextResponse } from "next/server";
import { requireCanReviewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { scopeNoteAssociationAction } from "@/lib/ac-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/acceptance-criteria/scope-notes — Manager/Admin: associate an
// acknowledged change-level scope note with (or remove it from) a promoted
// Requirement ({ project_id, scope_note_id, requirement_id, action, note? }).
export async function POST(req: NextRequest) {
  const denied = await requireCanReviewRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await scopeNoteAssociationAction(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
