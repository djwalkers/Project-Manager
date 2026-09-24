import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, requireAuthenticatedUser } from "@/lib/api-auth";
import { AUDITABLE_TABLES } from "@/lib/audit";
import { isUuid, normaliseAuditEntries } from "@/lib/audit-entry";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// Canonical audit write path. The browser reports WHAT changed (after its
// own data write succeeded); this route stamps WHO from the authenticated
// session — changed_by / changed_by_name are never taken from the request —
// and inserts with the service-role client. audit_log stays the single,
// append-only audit table (migration 009); migration 029 removes the
// client-side INSERT policy so this route is the only writer.

export async function POST(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { entries, error: validationError } = normaliseAuditEntries(body, AUDITABLE_TABLES as ReadonlySet<string>);
  if (validationError || !entries) return NextResponse.json({ error: validationError }, { status: 400 });

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  const changedBy = user?.id && isUuid(user.id) ? user.id : null;
  let changedByName = user?.email || "Unknown user";
  if (hasSupabaseConfig && changedBy) {
    const { data: profile } = await db.from("user_profiles").select("full_name").eq("id", changedBy).maybeSingle();
    if (profile?.full_name) changedByName = profile.full_name;
  }

  // audit_log.project_id references projects(id): keep it only for projects
  // that still exist, so e.g. a project's own Delete entry still persists.
  const projectIds = [...new Set(entries.map((e) => e.project_id).filter((id): id is string => id !== null))];
  let existing = new Set<string>();
  if (projectIds.length > 0) {
    const { data: rows, error: lookupError } = await db.from("projects").select("id").in("id", projectIds);
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    existing = new Set((rows ?? []).map((r: { id: string }) => r.id));
  }

  const rows = entries.map((e) => ({
    ...e,
    project_id: e.project_id && existing.has(e.project_id) ? e.project_id : null,
    changed_by: changedBy,
    changed_by_name: changedByName,
  }));
  const { error } = await db.from("audit_log").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ inserted: rows.length });
}
