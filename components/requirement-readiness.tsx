"use client";

import type { AcceptanceCriteria, Evidence, RequirementSignOff, TestCase } from "@/lib/types";

export type ReadinessDimension = {
  label: string;
  pct: number;
  detail: string;
};

export function computeReadiness(
  criteria: AcceptanceCriteria[],
  evidence: Evidence[],
  signOffs: RequirementSignOff[],
  testCases: TestCase[],
): { dimensions: ReadinessDimension[]; overall: number } {
  const acTotal = criteria.length;
  const acMet = criteria.filter((ac) => ac.status === "Met" || ac.status === "Waived").length;
  const acPct = acTotal > 0 ? Math.round((acMet / acTotal) * 100) : 0;

  const acWithEvidence = acTotal > 0
    ? criteria.filter((ac) => evidence.some((ev) => ev.ac_id === ac.id)).length
    : 0;
  const evidencePct = acTotal > 0 ? Math.round((acWithEvidence / acTotal) * 100) : 0;

  const testTotal = testCases.length;
  const testPassed = testCases.filter((t) => t.status === "Passed").length;
  const testPct = testTotal > 0 ? Math.round((testPassed / testTotal) * 100) : 0;

  const signOffTotal = signOffs.length;
  const signOffApproved = signOffs.filter((s) => s.status === "Approved").length;
  const signOffPct = signOffTotal > 0 ? Math.round((signOffApproved / signOffTotal) * 100) : 0;

  const dimensions: ReadinessDimension[] = [
    { label: "Acceptance", pct: acPct,        detail: `${acMet}/${acTotal} criteria met` },
    { label: "Evidence",   pct: evidencePct,   detail: `${acWithEvidence}/${acTotal} criteria have evidence` },
    { label: "Testing",    pct: testPct,        detail: `${testPassed}/${testTotal} tests passed (project)` },
    { label: "Sign-off",   pct: signOffPct,     detail: `${signOffApproved}/${signOffTotal} sign-offs approved` },
  ];

  const overall = Math.round(
    acPct * 0.30 +
    evidencePct * 0.20 +
    testPct * 0.30 +
    signOffPct * 0.20,
  );

  return { dimensions, overall };
}

function DimBar({ dim }: { dim: ReadinessDimension }) {
  const color = dim.pct === 100 ? "bg-green-500" : dim.pct >= 70 ? "bg-primary" : dim.pct >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{dim.label}</span>
        <span className="tabular-nums text-muted-foreground">{dim.pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-[width] duration-300 ${color}`} style={{ width: `${dim.pct}%` }} />
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{dim.detail}</p>
    </div>
  );
}

export function RequirementReadiness({
  criteria,
  evidence,
  signOffs,
  testCases,
}: {
  criteria: AcceptanceCriteria[];
  evidence: Evidence[];
  signOffs: RequirementSignOff[];
  testCases: TestCase[];
}) {
  const { dimensions, overall } = computeReadiness(criteria, evidence, signOffs, testCases);
  const overallColor = overall === 100 ? "text-green-700" : overall >= 70 ? "text-primary" : overall >= 40 ? "text-amber-600" : "text-red-600";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Requirement Readiness</p>
        <span className={`text-sm font-bold tabular-nums ${overallColor}`}>{overall}% Overall</span>
      </div>
      <div className="space-y-2.5">
        {dimensions.map((dim) => <DimBar key={dim.label} dim={dim} />)}
      </div>
    </div>
  );
}
