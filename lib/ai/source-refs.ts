// Phase D — maps a business reference prefix (RSK-001, ACT-005, ...) to the
// page that owns it, so validated sources can render as links. Matches the
// nav routes in lib/nav-data.ts exactly. Prefixes with no established page
// (e.g. milestones, dependencies — see lib/ai/project-assistant-dto.ts's
// comments on why those have no *_ref) fall through to null, and the badge
// renders without a link rather than guessing.
const PREFIX_ROUTES: Record<string, string> = {
  RSK: "/risks",
  ACT: "/actions",
  DEC: "/decisions",
  TEST: "/testing",
  AC: "/acceptance-criteria",
  DEL: "/deliverables",
  REQ: "/requirements",
  GLC: "/go-live-readiness",
};

export function sourceRefHref(ref: string): string | null {
  const prefix = ref.split("-")[0]?.toUpperCase();
  return (prefix && PREFIX_ROUTES[prefix]) ?? null;
}
