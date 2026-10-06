import { Suspense } from "react";
import { TestGenerationReviewPage } from "@/components/test-generation-review-page";

// /test-generation-review/<runId>?project=<projectId> — read-only inspection of
// one AI test case generation run (Phase 1G). Manager/Admin only; the tests
// are non-authoritative proposals and cannot be promoted here.
export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={null}>
      <TestGenerationReviewPage runId={runId} />
    </Suspense>
  );
}
