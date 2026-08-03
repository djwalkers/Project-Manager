// Phase D — best-effort structured rendering for feasibility answers.
//
// local-gateway/prompt.js's FEASIBILITY_RULES asks the model for exactly
// seven labelled sections in a fixed order (see that file). Models don't
// always follow formatting instructions perfectly, so this parser is
// deliberately lenient (case-insensitive, whitespace-tolerant) and returns
// null — never throws — if it can't confidently find every section in
// order. Callers must fall back to normal markdown rendering on null.
export type FeasibilityAnswer = {
  assessment: string;
  confidence: string;
  supportingEvidence: string;
  threatsAndDependencies: string;
  assumptions: string;
  recommendedNextAction: string;
  sources: string;
};

const SECTION_ORDER: Array<{ key: keyof FeasibilityAnswer; label: string }> = [
  { key: "assessment", label: "Assessment" },
  { key: "confidence", label: "Confidence" },
  { key: "supportingEvidence", label: "Supporting evidence" },
  { key: "threatsAndDependencies", label: "Threats and dependencies" },
  { key: "assumptions", label: "Assumptions" },
  { key: "recommendedNextAction", label: "Recommended next action" },
  { key: "sources", label: "Sources" },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseFeasibilityAnswer(text: string): FeasibilityAnswer | null {
  const positions: Array<{ index: number; headerLength: number }> = [];

  for (const section of SECTION_ORDER) {
    const pattern = new RegExp(`^[ \\t]*${escapeRegExp(section.label)}[ \\t]*:`, "im");
    const match = pattern.exec(text);
    if (!match) return null; // a required section is missing — fall back to markdown
    positions.push({ index: match.index, headerLength: match[0].length });
  }

  for (let i = 1; i < positions.length; i++) {
    if (positions[i].index <= positions[i - 1].index) return null; // out of order — unreliable, fall back
  }

  const result = {} as FeasibilityAnswer;
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const start = positions[i].index + positions[i].headerLength;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    result[SECTION_ORDER[i].key] = text.slice(start, end).trim();
  }
  return result;
}
