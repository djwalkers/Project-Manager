// ── Test Case review and promotion (Phase 1H) — shared rules ────────────────
//
// Importable from client components and server routes. The database is the
// authority (migration 048 triggers and functions); these helpers mirror it
// so the UI offers only actions valid for the current state and explains
// what stands between a proposal and approval. Same lifecycle as Phase 1F:
//
//   Proposed     → Approve | Needs Review | Reject | Edit | Split | Merge
//   Needs Review → Approve (when its reasons are resolved) | Reject | Edit | Split | Merge
//   Approved     → Promote | Needs Review | Reject | Edit (→ Needs Review) | Split | Merge
//   Rejected     → Reopen (→ Needs Review)
//   Promoted, Superseded → view only
//
// It also holds the server-side similarity check against existing canonical
// tests (advisory only — existing tests are never given to the model).

import type { TestCaseProposal, TestStep, TestType } from "@/lib/test-generation";

export const TEST_REJECTION_REASONS = ["Duplicate", "Duplicate of an existing test", "Incorrect interpretation", "Unsupported behaviour", "Too granular", "Out of scope", "Not testable", "Other"] as const;
export type TestRejectionReason = (typeof TEST_REJECTION_REASONS)[number];
export type TestProposalAction = "edit" | "approve" | "needs_review" | "reject" | "reopen" | "split" | "merge" | "promote";

/** Canonical status of every promoted test (the existing initial Test status; never chosen by AI). */
export const PROMOTED_TEST_STATUS = "Pending";

export type AcSnapshot = {
  id: string; ref: string; requirement_id: string; criterion: string; description: string | null; criterion_type: string | null;
  given_text: string | null; when_text: string | null; then_text: string | null; status: string | null; fingerprint: string;
};

export type ReviewedTestProposal = TestCaseProposal & {
  project_id: string;
  origin: "ai" | "split" | "merge" | "manual";
  parent_proposal_ids: string[];
  human_authored: boolean;
  reviewed_title: string | null;
  reviewed_objective: string | null;
  reviewed_preconditions: string[] | null;
  reviewed_steps: TestStep[] | null;
  reviewed_expected_result: string | null;
  reviewed_test_type: TestType | null;
  review_note: string | null;
  rejection_reason: TestRejectionReason | null;
  accepted_inferences: string[];
  approved_ac_snapshot: AcSnapshot[] | null;
  review_confirmed_at: string | null;
  review_confirmed_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  promoted_test_id: string | null;
  promoted_test_ref: string | null;
  promoted_at: string | null;
  promoted_by_name: string | null;
};

type EffectiveSource = Pick<ReviewedTestProposal, "title" | "objective" | "preconditions" | "steps" | "expected_result" | "test_type"
  | "reviewed_title" | "reviewed_objective" | "reviewed_preconditions" | "reviewed_steps" | "reviewed_expected_result" | "reviewed_test_type">;

/** The version a reviewer sees and promotion uses: reviewed_* when set, otherwise the AI's values. */
export function effectiveTest(p: EffectiveSource) {
  return {
    title: p.reviewed_title ?? p.title,
    objective: p.reviewed_objective ?? p.objective,
    preconditions: p.reviewed_preconditions ?? p.preconditions,
    steps: p.reviewed_steps ?? p.steps,
    expected_result: p.reviewed_expected_result ?? p.expected_result,
    test_type: p.reviewed_test_type ?? p.test_type,
  };
}

export function isEditedTest(p: Pick<ReviewedTestProposal, "reviewed_title" | "reviewed_objective" | "reviewed_preconditions" | "reviewed_steps" | "reviewed_expected_result" | "reviewed_test_type">): boolean {
  return [p.reviewed_title, p.reviewed_objective, p.reviewed_preconditions, p.reviewed_steps, p.reviewed_expected_result, p.reviewed_test_type].some((v) => v != null);
}

export function allowedTestActions(p: Pick<ReviewedTestProposal, "review_status">): TestProposalAction[] {
  switch (p.review_status) {
    case "Proposed": return ["approve", "needs_review", "reject", "edit", "split", "merge"];
    case "Needs Review": return ["approve", "reject", "edit", "split", "merge"];
    case "Approved": return ["promote", "needs_review", "reject", "edit", "split", "merge"];
    case "Rejected": return ["reopen"];
    default: return [];
  }
}

/**
 * How a Needs Review reason is satisfied (mirrors test_approval_blockers).
 * unsupported: remove the detail, or accept it as Inferred with a reason ·
 * vague: make the expected result specific · condition: restore the named
 * term · confirm: explicit reviewer confirmation.
 */
export type TestReasonKind = "unsupported" | "vague" | "condition" | "confirm";
export function testReasonKind(reason: string): TestReasonKind {
  if (/^(Unsupported procedure detail|Expected result introduces an unsupported interpretation)/i.test(reason)) return "unsupported";
  if (/^Vague expected result/i.test(reason)) return "vague";
  if (/^Omits /i.test(reason)) return "condition";
  return "confirm";
}
export const TEST_REASON_GUIDANCE: Record<TestReasonKind, string> = {
  unsupported: "Not established by the acceptance criteria or their context. Remove it from the test, or accept it as Inferred and record why.",
  vague: "Make the expected result specific enough to check.",
  condition: "Restore the named condition in the test.",
  confirm: "Review against the acceptance criteria and confirm when approving.",
};

/** Quoted terms of the unsupported-detail reasons still present in the effective wording (mirrors test_unsupported_terms). */
export function unsupportedTerms(p: EffectiveSource & Pick<ReviewedTestProposal, "needs_review_reasons">): string[] {
  const text = proposalText(p);
  const out = new Set<string>();
  for (const r of p.needs_review_reasons) {
    if (testReasonKind(r) !== "unsupported") continue;
    for (const m of r.matchAll(/"([^"]+)"/g)) if (text.includes(m[1].toLowerCase())) out.add(m[1]);
  }
  return [...out];
}

export function proposalText(p: EffectiveSource): string {
  const e = effectiveTest(p);
  return [e.title, e.objective, e.preconditions.join(" "), e.steps.map((s) => [s.action, s.expected].filter(Boolean).join(" ")).join(" "), e.expected_result].join(" ").toLowerCase();
}

/** Canonical scenario text for a promoted test (mirrors promote_test_proposal; the existing "Objective: … Steps: 1) …" convention). */
export function canonicalScenario(p: EffectiveSource): string {
  const e = effectiveTest(p);
  return [`${e.title}.`, `Objective: ${e.objective}`, e.preconditions.length ? `Preconditions: ${e.preconditions.join("; ")}.` : null,
    `Steps: ${e.steps.map((s, i) => `${i + 1}) ${s.action}${s.expected ? ` → ${s.expected}` : ""}`).join(" ")}`].filter(Boolean).join(" ");
}

// ── Similar existing tests (server-side, advisory) ──────────────────────────

const STOP = new Set(("the and for with that this from into onto then than when where which while will shall should must can cannot not are was were has have had " +
  "its it's their there been being any all each per via upon after before under over also only same such other own test tests testing verify verifies verified check " +
  "checks ensure ensures user users step steps expected result results open opens select selects click clicks shown shows show displayed display").split(" "));

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function keyTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

export type CanonicalTestLite = { id: string; test_ref: string; scenario: string; expected_result: string | null; objective?: string | null; steps?: TestStep[] | null };
export type SimilarTest = { test_id: string; test_ref: string; scenario: string; score: number; shared_terms: string[]; same_ac_refs: string[] };

export const SIMILARITY_THRESHOLD = 0.5;

/**
 * Existing canonical tests that look like this proposal: half Dice, half
 * overlap of key terms (title, objective, steps, expected result vs
 * scenario, expected result and any structure), plus a small boost when the
 * existing test is already linked to one of the proposal's ACs. Advisory —
 * the reviewer decides whether to reject, merge conceptually or promote.
 */
export function similarTests(
  proposal: EffectiveSource & Pick<ReviewedTestProposal, "source_ac_ids">,
  tests: CanonicalTestLite[],
  acsByTest: Map<string, Set<string>>,
  acRefs: Map<string, string>,
  opts: { exclude?: string | null; limit?: number; threshold?: number } = {},
): SimilarTest[] {
  const mine = keyTerms(proposalText(proposal));
  if (!mine.size) return [];
  const out: SimilarTest[] = [];
  for (const t of tests) {
    if (t.id === opts.exclude) continue;
    const theirs = keyTerms([t.scenario, t.expected_result, t.objective, (t.steps ?? []).map((s) => `${s.action} ${s.expected ?? ""}`).join(" ")].filter(Boolean).join(" "));
    if (!theirs.size) continue;
    const shared = [...mine].filter((w) => theirs.has(w));
    const dice = (2 * shared.length) / (mine.size + theirs.size);
    const overlap = shared.length / Math.min(mine.size, theirs.size);
    const sameAc = proposal.source_ac_ids.filter((a) => acsByTest.get(t.id)?.has(a));
    const score = Math.min(1, 0.5 * dice + 0.5 * overlap + (sameAc.length ? 0.1 : 0));
    if (score >= (opts.threshold ?? SIMILARITY_THRESHOLD) && shared.length >= 3) {
      out.push({ test_id: t.id, test_ref: t.test_ref, scenario: t.scenario.slice(0, 200), score: Math.round(score * 100) / 100, shared_terms: shared.slice(0, 8), same_ac_refs: sameAc.map((a) => acRefs.get(a) ?? "AC") });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 3);
}
