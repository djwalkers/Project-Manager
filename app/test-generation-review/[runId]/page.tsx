import { Suspense } from "react";
import { TestGenerationReviewPage } from "@/components/test-generation-review-page";

// /test-generation-review/<runId>?project=<projectId> — review workspace for
// one AI test case generation run (Phase 1G generation, Phase 1H review and
// promotion). Manager/Admin only; Viewers see canonical tests on Testing.
export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={null}>
      <TestGenerationReviewPage runId={runId} />
    </Suspense>
  );
}
