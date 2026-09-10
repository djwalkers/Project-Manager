import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, requireAdminOrManagerUser, requireAuthenticatedUser } from "@/lib/api-auth";
import {
  GO_LIVE_MANUAL_CHECK_KEYS,
  GO_LIVE_MANUAL_CHECK_STATUSES,
  GO_LIVE_OVERRIDABLE_CHECK_KEYS,
  GO_LIVE_OVERRIDE_STATUSES,
} from "@/lib/go-live-readiness";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const TABLE = "go_live_readiness_overrides";

function isAutoCheckKey(value: unknown): boolean {
  return typeof value === "string" && (GO_LIVE_OVERRIDABLE_CHECK_KEYS as readonly string[]).includes(value);
}
function isManualCheckKey(value: unknown): boolean {
  return typeof value === "string" && (GO_LIVE_MANUAL_CHECK_KEYS as readonly string[]).includes(value);
}

// Auto checks may only be set to a real assessed outcome (Complete /
// Incomplete / Waived) — the two structural states are never a human
// decision for an auto-derived check. Manual checks use the full 5-value
// readiness vocabulary, since a manual check's source of truth is the
// human assessment itself (see lib/go-live-readiness.ts).
function allowedStatusesFor(checkKey: string): readonly string[] {
  return isManualCheckKey(checkKey) ? GO_LIVE_MANUAL_CHECK_STATUSES : GO_LIVE_OVERRIDE_STATUSES;
}

// Shared validation for both POST (new override/assessment) and PATCH (edit
// an existing one). check_key must be one of the 7 auto-derived checks or
// the 5 manual checks (POST only — PATCH/DELETE resolve the check_key of
// the row being edited from the database, never from client-supplied body
// data, so a client can't relabel a manual row as an auto one to dodge the
// Admin/Manager gate or the wider manual status vocabulary). Validated
// server-side regardless of what the client sends.
function validateOverrideBody(body: Record<string, unknown>, checkKey: string, { requireProjectId }: { requireProjectId: boolean }) {
  if (requireProjectId && (typeof body.project_id !== "string" || !body.project_id)) return "project_id is required";
  const allowed = allowedStatusesFor(checkKey);
  if (typeof body.override_status !== "string" || !allowed.includes(body.override_status)) {
    return `override_status must be one of: ${allowed.join(", ")}`;
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

  if (typeof body.check_key !== "string" || !(isAutoCheckKey(body.check_key) || isManualCheckKey(body.check_key))) {
    return NextResponse.json(
      { error: `check_key must be one of: ${[...GO_LIVE_OVERRIDABLE_CHECK_KEYS, ...GO_LIVE_MANUAL_CHECK_KEYS].join(", ")}` },
      { status: 400 },
    );
  }
  const checkKey = body.check_key;

  const validationError = validateOverrideBody(body, checkKey, { requireProjectId: true });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  // Recording a manual-check assessment (as opposed to an Auto override) is
  // restricted to Admin/Manager — Viewer is read-only. Auto overrides keep
  // their existing (any-authenticated-user) behaviour unchanged.
  if (isManualCheckKey(checkKey)) {
    const permissionError = await requireAdminOrManagerUser();
    if (permissionError) return permissionError;
  }

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

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  // check_key is resolved from the existing row, never from the client
  // body — the row's real check_key decides which status vocabulary
  // applies and whether the Admin/Manager gate applies, so a client can't
  // spoof it via the request body (check_key is immutable once created).
  const { data: existing, error: lookupError } = await db.from(TABLE).select("check_key").eq("id", body.id).maybeSingle();
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Override not found" }, { status: 404 });

  const validationError = validateOverrideBody(body, existing.check_key, { requireProjectId: false });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  if (isManualCheckKey(existing.check_key)) {
    const permissionError = await requireAdminOrManagerUser();
    if (permissionError) return permissionError;
  }

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

  const { data: existing, error: lookupError } = await db.from(TABLE).select("check_key").eq("id", id).maybeSingle();
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });

  if (existing && isManualCheckKey(existing.check_key)) {
    const permissionError = await requireAdminOrManagerUser();
    if (permissionError) return permissionError;
  }

  const { error } = await db.from(TABLE).delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
