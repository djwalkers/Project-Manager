"use client";

import { createRecord, hasSupabaseConfig } from "@/lib/supabase/data-store";
import type { GoLiveDecision, GoLiveDecisionValue } from "@/lib/types";

// The ONLY client write path for Go/No-Go decisions: a user's deliberate
// action on the Go-Live Readiness screen. Nothing derives or submits a
// decision automatically (readiness, tests, ProjectState, RAG and AI never
// call this). With Supabase configured it goes through the authenticated,
// Admin/Manager-only API route, which stamps who/when server-side.
export async function recordGoLiveDecision(input: { project_id: string; decision: GoLiveDecisionValue; reason: string; localUser?: string }): Promise<GoLiveDecision> {
  if (!hasSupabaseConfig) {
    const now = new Date().toISOString();
    return await createRecord("go_live_decisions", {
      project_id: input.project_id,
      decision: input.decision,
      reason: input.reason.trim(),
      decided_by: input.localUser ?? "local@dev",
      decided_by_user_id: null,
      decided_at: now,
    }) as GoLiveDecision;
  }
  const res = await fetch("/api/go-live/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: input.project_id, decision: input.decision, reason: input.reason }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Failed to record decision (${res.status})`);
  return body as GoLiveDecision;
}
