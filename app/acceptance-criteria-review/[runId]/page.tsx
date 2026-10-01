import { Suspense } from "react";
import { AcGenerationReviewPage } from "@/components/ac-generation-review-page";

// /acceptance-criteria-review/<runId>?project=<projectId> — inspection of one
// AI acceptance criteria generation run (Phase 1E). Manager/Admin only; the
// criteria are non-authoritative proposals and cannot be promoted here.
export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={null}>
      <AcGenerationReviewPage runId={runId} />
    </Suspense>
  );
}
