import { Suspense } from "react";
import { AcGenerationReviewPage } from "@/components/ac-generation-review-page";

// /acceptance-criteria-review/<runId>?project=<projectId> — review workspace
// for one AI acceptance criteria generation run (Phase 1F). Manager/Admin
// only; approved proposals are promoted here, one at a time, into canonical
// Acceptance Criteria.
export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={null}>
      <AcGenerationReviewPage runId={runId} />
    </Suspense>
  );
}
