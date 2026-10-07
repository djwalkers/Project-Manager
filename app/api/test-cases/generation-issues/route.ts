import { NextRequest, NextResponse } from "next/server";
import { requireCanReviewRequirementAnalysis, resolveActor } from "@/lib/api-auth";
import { testIssueAction } from "@/lib/test-review-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/test-cases/generation-issues — Manager/Admin: set a test-design
// issue's status ({ project_id, issue_id, status, note }). Open / Resolved /
// Accepted / Not Applicable; never affects canonical tests.
export async function POST(req: NextRequest) {
  const denied = await requireCanReviewRequirementAnalysis();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await testIssueAction(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
