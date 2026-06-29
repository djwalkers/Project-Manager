"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AcceptanceCriteria, Evidence, RequirementSignOff, TestCase } from "@/lib/types";

type Gate = { label: string; passed: boolean };

function buildGates(
  criteria: AcceptanceCriteria[],
  evidence: Evidence[],
  signOffs: RequirementSignOff[],
  testCases: TestCase[],
): Gate[] {
  const acIncomplete = criteria.length > 0 && criteria.some((ac) => !["Met", "Waived"].includes(ac.status));
  const acMissing = criteria.length === 0;
  const failedTests = testCases.some((t) => t.status === "Failed");
  const noEvidence = criteria.length > 0 && criteria.every((ac) => !evidence.some((ev) => ev.ac_id === ac.id));
  const pendingSignOffs = signOffs.some((s) => s.status === "Pending");
  const rejectedSignOffs = signOffs.some((s) => s.status === "Rejected");

  return [
    { label: "Acceptance criteria defined", passed: !acMissing },
    { label: "All acceptance criteria met or waived", passed: !acIncomplete && !acMissing },
    { label: "No failed tests", passed: !failedTests },
    { label: "Evidence attached to acceptance criteria", passed: !noEvidence && criteria.length > 0 },
    { label: "No outstanding sign-offs", passed: signOffs.length > 0 && !pendingSignOffs && !rejectedSignOffs },
  ];
}

export function ReadinessGates({
  criteria,
  evidence,
  signOffs,
  testCases,
  requirementStatus,
}: {
  criteria: AcceptanceCriteria[];
  evidence: Evidence[];
  signOffs: RequirementSignOff[];
  testCases: TestCase[];
  requirementStatus: string;
}) {
  const gates = buildGates(criteria, evidence, signOffs, testCases);
  const failing = gates.filter((g) => !g.passed);
  const isComplete = ["Complete", "Approved", "Closed"].includes(requirementStatus);

  if (failing.length === 0 && !isComplete) return null;
  if (failing.length === 0 && isComplete) return (
    <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      All readiness gates passed — this requirement is ready for sign-off.
    </div>
  );

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <p className="text-xs font-semibold text-amber-800">
          {isComplete ? "This requirement is marked Complete but:" : "Before marking Complete:"}
        </p>
      </div>
      <ul className="space-y-1">
        {gates.map((gate) => (
          <li key={gate.label} className="flex items-center gap-1.5 text-xs">
            {gate.passed
              ? <CheckCircle2 className="h-3 w-3 shrink-0 text-green-600" />
              : <span className="h-3 w-3 shrink-0 text-red-600 font-bold leading-none">✗</span>}
            <span className={gate.passed ? "text-muted-foreground" : "text-amber-900 font-medium"}>{gate.label}</span>
          </li>
        ))}
      </ul>
      {failing.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">This is guidance only — completion is not blocked.</p>
      )}
    </div>
  );
}
