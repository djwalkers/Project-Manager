import { NextRequest, NextResponse } from "next/server";
import { requireCanManageSourceDocuments, resolveActor } from "@/lib/api-auth";
import { setCurrentVersion } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// PATCH /api/source-documents/current — Manager/Admin. Makes an existing
// version of the document the current one (older versions stay available).
export async function PATCH(req: NextRequest) {
  const denied = await requireCanManageSourceDocuments();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await setCurrentVersion(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
