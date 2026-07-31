import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/api-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const TABLE = "cutover_plan";

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

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { data, error } = await db.from(TABLE).insert(body).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const authError = await requireAuthenticatedUser();
  if (authError) return authError;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 500 });

  let body: Record<string, unknown> & { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { id, ...rest } = body;
  const { data, error } = await db.from(TABLE).update(rest).eq("id", id).select().single();
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
