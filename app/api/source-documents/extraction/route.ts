import { NextRequest, NextResponse } from "next/server";
import { requireCanManageSourceDocuments, resolveActor } from "@/lib/api-auth";
import { queueExtraction } from "@/lib/extraction-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/source-documents/extraction — Manager/Admin. Queues (or, after a
// failure, retries) extraction of one version. A completed extraction is
// never silently replaced.
export async function POST(req: NextRequest) {
  const denied = await requireCanManageSourceDocuments();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await queueExtraction(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
