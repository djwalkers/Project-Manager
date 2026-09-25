import { NextRequest, NextResponse } from "next/server";
import { requireCanReadProjectData } from "@/lib/api-auth";
import { signDownload } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/source-documents/download?project_id=&version_id=&disposition=inline|attachment
// Any signed-in Viewer/Manager/Admin. Returns a 60-second signed URL for
// that version's original file after checking it belongs to the project.
export async function GET(req: NextRequest) {
  const denied = await requireCanReadProjectData();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const params = req.nextUrl.searchParams;
  const result = await signDownload(db, {
    projectId: params.get("project_id") ?? "", versionId: params.get("version_id") ?? "",
    disposition: params.get("disposition") ?? "inline",
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
