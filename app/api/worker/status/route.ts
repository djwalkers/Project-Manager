import { NextResponse } from "next/server";
import { requireAdminOrManagerUser } from "@/lib/api-auth";
import { workerStatus } from "@/lib/extraction-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// GET /api/worker/status — Manager/Admin (System Health): worker availability and queue.
export async function GET() {
  const denied = await requireAdminOrManagerUser();
  if (denied) return denied;
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await workerStatus(db);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
