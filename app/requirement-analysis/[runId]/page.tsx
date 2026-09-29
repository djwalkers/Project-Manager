import { Suspense } from "react";
import { RequirementAnalysisPage } from "@/components/requirement-analysis-page";

// /requirement-analysis/<runId>?project=<projectId> — the review workspace for
// one AI analysis run (Phase 1C). Manager/Admin only; proposals are
// non-authoritative and cannot be promoted from here yet.
export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={null}>
      <RequirementAnalysisPage runId={runId} />
    </Suspense>
  );
}
