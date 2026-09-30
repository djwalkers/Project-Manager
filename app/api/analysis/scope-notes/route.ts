import { NextRequest, NextResponse } from "next/server";
import { requireCanReviewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { scopeNoteAction } from "@/lib/requirement-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/analysis/scope-notes — Manager/Admin (Phase 1D): acknowledge (scope notes are never promoted).
export async function POST(req: NextRequest) {
  const denied = await requireCanReviewRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await scopeNoteAction(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
