import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser, requireCanCreateProject } from "@/lib/api-auth";
import { buildNewProjectRecord, findConflictingProject, validateNewProjectInput, type NewProjectInput } from "@/lib/project-creation";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const TABLE = "projects";

// Projects are created here (service-role client) rather than through the
// generic client-side createRecord()/anon-key path every other module uses
// — the projects table's RLS only permits Admin to write (see
// supabase/migrations/008_auth_rls.sql), which would silently reject a
// Manager's insert even though canCreateProject() allows it. Routing
// through this server-enforced path is the same fix already applied to
// go_live_checklists/cutover_plan/go_live_readiness_overrides (see
// lib/supabase/data-store.ts's AUTH_ROUTED_TABLE_PATHS) — a service-role
// client bypassing RLS entirely, with the real permission check done here
// instead. Only POST (create) is implemented: editing/deleting an existing
// project is unaffected by this change and still goes through the
// pre-existing generic path.
export async function POST(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const validationError = validateNewProjectInput(body as Partial<NewProjectInput>);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const permissionError = await requireCanCreateProject();
  if (permissionError) return permissionError;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const { data: existing, error: fetchError } = await db.from(TABLE).select("name, project_ref");
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });

  const conflict = findConflictingProject(existing ?? [], body as NewProjectInput);
  if (conflict) {
    return NextResponse.json(
      { error: `A project with this ${conflict.field === "name" ? "name" : "reference"} ("${conflict.value}") already exists` },
      { status: 409 },
    );
  }

  const record = buildNewProjectRecord(body as NewProjectInput);
  const { data, error } = await db.from(TABLE).insert(record).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}
