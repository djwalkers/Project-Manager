import { NextRequest, NextResponse } from "next/server";
import { requireCanConfigureSystem, resolveActor } from "@/lib/api-auth";
import { issueWorkerToken } from "@/lib/extraction-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/worker/credentials — Admin only. Issues a new extraction-worker
// token (returned once; only its hash is stored) and revokes the old one.
export async function POST(req: NextRequest) {
  const denied = await requireCanConfigureSystem();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const result = await issueWorkerToken(db, await resolveActor(db), (body ?? {}) as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
