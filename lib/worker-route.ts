import { NextRequest, NextResponse } from "next/server";
import { authenticateWorker, type WorkerIdentity } from "@/lib/extraction-server";
import type { ServiceResult } from "@/lib/source-documents-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Wraps a local-worker route: the request must carry an active extraction
 * worker token (Authorization: Bearer tmw_…). Browser sessions are not
 * accepted here, and the worker token is accepted nowhere else.
 */
export function workerRoute(handler: (db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>) => Promise<ServiceResult>) {
  return async function POST(req: NextRequest) {
    const db = createServiceRoleClient();
    if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
    const worker = await authenticateWorker(db, req.headers.get("authorization"));
    if (!worker) return NextResponse.json({ error: "Unauthorized worker" }, { status: 401 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    const result = await handler(db, worker, body as Record<string, unknown>);
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  };
}
