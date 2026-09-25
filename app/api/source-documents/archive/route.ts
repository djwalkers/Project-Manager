import { NextRequest, NextResponse } from "next/server";
import { requireCanArchiveOrDeleteSourceDocuments, resolveActor } from "@/lib/api-auth";
import { setArchived } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/source-documents/archive — Admin only. { project_id, document_id, archived }.
export async function POST(req: NextRequest) {
  const denied = await requireCanArchiveOrDeleteSourceDocuments();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await setArchived(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
