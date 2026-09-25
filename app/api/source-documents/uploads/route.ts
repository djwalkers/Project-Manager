import { NextRequest, NextResponse } from "next/server";
import { requireCanManageSourceDocuments } from "@/lib/api-auth";
import { prepareUpload } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// POST /api/source-documents/uploads — Manager/Admin. Validates the proposed
// file and returns a one-time signed upload URL token for a fresh,
// project-scoped object path in the private bucket.
export async function POST(req: NextRequest) {
  const denied = await requireCanManageSourceDocuments();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await prepareUpload(db, body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
