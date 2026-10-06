import { NextRequest, NextResponse } from "next/server";
import { requireCanReviewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { acProposalAction } from "@/lib/ac-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/acceptance-criteria/proposals — Manager/Admin: review an AI
// acceptance criterion proposal ({ project_id, action, ... }): edit, approve,
// needs_review, reject, reopen, bulk_review, split, merge, create_manual,
// promote (one proposal → one canonical AC) or supersede_older (adopt a run).
export async function POST(req: NextRequest) {
  const denied = await requireCanReviewRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await acProposalAction(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
