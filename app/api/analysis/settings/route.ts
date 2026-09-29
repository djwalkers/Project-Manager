import { NextRequest, NextResponse } from "next/server";
import { requireCanConfigureSystem } from "@/lib/api-auth";
import { setAnalysisModel } from "@/lib/requirement-analysis-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// PATCH /api/analysis/settings — Admin only: choose the local Ollama model
// used for requirement analysis ({ model }, or { model: null } for the default).
export async function PATCH(req: NextRequest) {
  const denied = await requireCanConfigureSystem();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  const result = await setAnalysisModel(db, body as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
