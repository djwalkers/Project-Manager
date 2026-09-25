import { NextRequest, NextResponse } from "next/server";
import { requireCanArchiveOrDeleteSourceDocuments, requireCanManageSourceDocuments, resolveActor } from "@/lib/api-auth";
import { deleteDocument, finalizeUpload } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const misconfigured = () => NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });

// POST /api/source-documents — Manager/Admin. Records an uploaded file as a
// new source document (version 1) or as the next version of an existing one.
export async function POST(req: NextRequest) {
  const denied = await requireCanManageSourceDocuments();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return misconfigured();
  const result = await finalizeUpload(db, await resolveActor(db), body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}

// DELETE /api/source-documents?project_id=&document_id= — Admin only, and
// only for an archived document. Removes the document, all its versions and
// their stored files.
export async function DELETE(req: NextRequest) {
  const denied = await requireCanArchiveOrDeleteSourceDocuments();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return misconfigured();
  const params = req.nextUrl.searchParams;
  const result = await deleteDocument(db, await resolveActor(db), {
    projectId: params.get("project_id") ?? "", documentId: params.get("document_id") ?? "",
  });
  return NextResponse.json(result.body, { status: result.status });
}
