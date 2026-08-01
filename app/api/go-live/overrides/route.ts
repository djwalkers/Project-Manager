import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, requireAuthenticatedUser } from "@/lib/api-auth";
import { GO_LIVE_OVERRIDABLE_CHECK_KEYS, GO_LIVE_OVERRIDE_STATUSES } from "@/lib/go-live-readiness";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const TABLE = "go_live_readiness_overrides";

function isValidOverrideStatus(value: unknown): value is (typeof GO_LIVE_OVERRIDE_STATUSES)[number] {
  return typeof value === "string" && (GO_LIVE_OVERRIDE_STATUSES as readonly string[]).includes(value);
}

// Shared validation for both POST (new override) and PATCH (edit an
// existing one) — check_key must be one of the 7 auto-derived checks and
// override_status must be one of the three allowed values, validated
// server-side regardless of what the client sends.
function validateOverrideBody(body: Record<string, unknown>, { requireProjectAndKey }: { requireProjectAndKey: boolean }) {
  if (requireProjectAndKey) {
    if (typeof body.project_id !== "string" || !body.project_id) return "project_id is required";
    if (typeof body.check_key !== "string" || !(GO_LIVE_OVERRIDABLE_CHECK_KEYS as readonly string[]).includes(body.check_key)) {
      return `check_key must be one of: ${GO_LIVE_OVERRIDABLE_CHECK_KEYS.join(", ")}`;
    }
  }
  if (!isValidOverrideStatus(body.override_status)) {
    return `override_status must be one of: ${GO_LIVE_OVERRIDE_STATUSES.join(", ")}`;
  }
  if (typeof body.override_reason !== "string" || !body.override_reason.trim()) return "override_reason is required";
  return null;
}

export async function GET() {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const { data, error } = await db.from(TABLE).select("*").order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const validationError = validateOverrideBody(body, { requireProjectAndKey: true });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  // overridden_at/overridden_by are always stamped from the authenticated
  // request server-side, never trusted from the client body.
  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  const now = new Date().toISOString();
  const record = {
    project_id: body.project_id,
    check_key: body.check_key,
    override_status: body.override_status,
    override_reason: body.override_reason,
    overridden_by: user?.email || user?.id || "unknown",
    overridden_at: now,
  };

  // Upsert on the (project_id, check_key) unique constraint — re-setting an
  // override for the same check replaces it rather than 23505-conflicting.
  const { data, error } = await db.from(TABLE).upsert(record, { onConflict: "project_id,check_key" }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  let body: Record<string, unknown> & { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const validationError = validateOverrideBody(body, { requireProjectAndKey: false });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  const { id, ...rest } = body;
  const record = {
    override_status: rest.override_status,
    override_reason: rest.override_reason,
    overridden_by: user?.email || user?.id || "unknown",
    overridden_at: new Date().toISOString(),
  };

  const { data, error } = await db.from(TABLE).update(record).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await db.from(TABLE).delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
