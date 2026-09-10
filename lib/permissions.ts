import type { UserRole } from "@/lib/auth";

// Go-Live Readiness manual checks (Customer Approval, Deployment / Cutover
// Approval, Rollback Plan Approved, Hypercare Owner Assigned, Support Rota
// Confirmed) are human-assessed release controls — only Admin/Manager may
// record an assessment; Viewer is read-only. Shared by the client-side edit
// action (components/go-live-readiness-page.tsx) and the server-side route
// guard (app/api/go-live/overrides/route.ts, via lib/api-auth.ts) so the
// rule lives in one place. Deliberately importable from both client
// components and server-only route handlers — unlike lib/auth.ts, this
// module has no "use client" directive (only a type import from it, which
// is erased at compile time).
export function canAssessManualChecks(role: UserRole | null | undefined): boolean {
  return role === "Admin" || role === "Manager";
}
