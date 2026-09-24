import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, requireAdminOrManagerUser, requireAuthenticatedUser } from "@/lib/api-auth";
import { validateDecisionBody } from "@/lib/go-live-decision";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// Go/No-Go decision history (supabase/migrations/028_go_live_decisions).
// Append-only: POST inserts a new decision; there is deliberately no
// PATCH/PUT/DELETE — a changed decision is a new row. Recording a decision
// is restricted to Admin/Manager (Viewer is read-only). decided_by /
// decided_by_user_id / decided_at are always stamped here from the
// authenticated session, never trusted from the request body.

const TABLE = "go_live_decisions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres "undefined_table": the migration hasn't been applied yet. Reads
// degrade to an empty history so the rest of the app keeps loading.
const UNDEFINED_TABLE = "42P01";

export async function GET() {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const { data, error } = await db.from(TABLE).select("*").order("decided_at", { ascending: true }).order("created_at", { ascending: true });
  if (error) {
    if (error.code === UNDEFINED_TABLE) return NextResponse.json([]);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  // Admin/Manager only — this guard also rejects unauthenticated requests.
  const permissionError = await requireAdminOrManagerUser();
  if (permissionError) return permissionError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const validationError = validateDecisionBody(body);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const { data: project, error: projectError } = await db.from("projects").select("id").eq("id", body.project_id as string).maybeSingle();
  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  let displayName = user?.email || user?.id || "unknown";
  if (hasSupabaseConfig && user?.id) {
    const { data: profile } = await db.from("user_profiles").select("full_name").eq("id", user.id).maybeSingle();
    if (profile?.full_name) displayName = `${profile.full_name}${user.email ? ` (${user.email})` : ""}`;
  }
  const userId = user?.id && UUID.test(user.id) ? user.id : null;

  const record = {
    project_id: body.project_id,
    decision: body.decision,
    reason: (body.reason as string).trim(),
    decided_by: displayName,
    decided_by_user_id: userId,
    decided_at: new Date().toISOString(),
  };
  const { data, error } = await db.from(TABLE).insert(record).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit Trail entry (append-only audit_log, migration 009). The decision
  // row itself is the governance record, so an audit write failure is
  // reported but does not undo the decision.
  const { error: auditError } = await db.from("audit_log").insert({
    project_id: data.project_id,
    entity_type: TABLE,
    entity_id: data.id,
    entity_name: `Go/No-Go decision: ${data.decision === "GO" ? "GO" : "NO GO"}`,
    action_type: "Create",
    field_name: "decision",
    old_value: null,
    new_value: data.decision,
    changed_by: userId,
    changed_by_name: displayName,
  });
  return NextResponse.json(auditError ? { ...data, audit_warning: auditError.message } : data);
}

function appendOnly() {
  return NextResponse.json({ error: "Go/No-Go decisions are append-only: record a new decision instead" }, { status: 405 });
}
export const PATCH = appendOnly;
export const PUT = appendOnly;
export const DELETE = appendOnly;
