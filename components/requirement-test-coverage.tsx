"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { formatVerificationLabel, type RequirementVerification } from "@/lib/lifecycle/test-verification";

// Derived, read-only view of Requirement -> Acceptance Criteria -> linked
// Test Cases (plus any test linked directly to the requirement). Purely a
// display of lib/lifecycle/test-verification.ts's canonical calculation —
// never writes to requirements.status, acceptance_criteria.status, or
// requirement_sign_offs.
export function RequirementTestCoverage({ verification }: { verification: RequirementVerification }) {
  const [expanded, setExpanded] = useState(false);
  const { tests } = verification;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Test Verification</p>
        <StatusBadge value={verification.state} />
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {verification.acCount} acceptance criteri{verification.acCount === 1 ? "on" : "a"} · {formatVerificationLabel(verification)}
        {verification.failed > 0 && <span className="ml-1 font-medium text-red-600">· {verification.failed} failed</span>}
        {verification.blocked > 0 && <span className="ml-1 font-medium text-amber-600">· {verification.blocked} blocked</span>}
      </p>

      {tests.length === 0 && (
        <p className="text-xs text-muted-foreground">No tests linked yet — link tests via Related Items below.</p>
      )}

      {tests.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? "Hide" : "Show"} {tests.length} linked test{tests.length > 1 ? "s" : ""}
          </button>

          {expanded && (
            <ul className="mt-2 space-y-1">
              {tests.map((t) => (
                <li key={t.testId} className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
                  <StatusBadge value={t.status} />
                  <span className="font-semibold text-primary">{t.testRef}</span>
                  <span className="flex-1 truncate">{t.scenario}</span>
                  {t.acceptanceCriteriaRefs.length > 0 && (
                    <span className="shrink-0 text-muted-foreground">{t.acceptanceCriteriaRefs.join(", ")}</span>
                  )}
                  <Link
                    href={`/testing?q=${encodeURIComponent(t.testRef)}`}
                    className="shrink-0 text-muted-foreground hover:text-primary"
                    title="Open test case"
                    aria-label={`Open test case ${t.testRef}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
