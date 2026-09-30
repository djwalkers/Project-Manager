"use client";

import { ExternalLink, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadRequirementProvenance, type RequirementProvenance } from "@/lib/requirement-analysis-client";
import { openSourceDocumentVersion } from "@/lib/source-documents-client";

// Source provenance of a canonical Requirement promoted from AI analysis
// (Phase 1D): Requirement → promoted proposal → source fragments →
// extraction → document version → original document. Read-only and shown to
// every role (it holds authoritative source facts, not proposal content).
// Renders nothing for Requirements that were not promoted from analysis.

const pagesOf = (f: { page_start: number | null; page_end: number | null }) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`;

export function RequirementProvenancePanel({ projectId, requirementId }: { projectId: string; requirementId: string }) {
  const [provenance, setProvenance] = useState<RequirementProvenance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProvenance(null);
    loadRequirementProvenance(projectId, requirementId)
      .then((r) => { if (live) setProvenance(r.provenance); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the source provenance."); });
    return () => { live = false; };
  }, [projectId, requirementId]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!provenance) return null;
  const { document, version, fragments, proposal, extraction_job: job } = provenance;
  const isPdf = version?.content_type === "application/pdf";
  const open = (page?: number | null) => {
    if (!version) return;
    openSourceDocumentVersion(projectId, version.id, "inline", isPdf ? page : null).catch((e) => setError(e instanceof Error ? e.message : "Could not open the original."));
  };

  return (
    <section aria-label="Source provenance" className="rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><FileText className="h-3.5 w-3.5" aria-hidden="true" />Source provenance</p>
      <p className="mt-2 text-sm">
        <span className="font-medium">{document?.document_name ?? "Source document"}</span> v{version?.version_number ?? "?"}
        <span className="text-muted-foreground"> · extractor {job?.extractor_version ?? "—"} · promoted from analysis proposal #{proposal.sequence}{proposal.origin !== "ai" ? ` (${proposal.origin === "split" ? "split" : "merged"} by a reviewer)` : ""} by {proposal.promoted_by_name ?? "—"}</span>
      </p>
      <ul className="mt-2 space-y-2">
        {fragments.map((f) => (
          <li key={f.id} className="rounded border bg-muted/30 p-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{f.section_path.length ? f.section_path.join(" › ") : f.section_heading ?? "Document start"}</span>
              <span className="text-muted-foreground">{pagesOf(f) ?? "not paginated"}</span>
            </div>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-muted-foreground">{f.text}</p>
            {isPdf && f.page_start ? <button type="button" className="mt-1 text-primary underline" onClick={() => open(f.page_start)}>Open original at page {f.page_start}</button> : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">This requirement was created from an approved AI proposal, so it cannot be deleted — its promotion history must be preserved. Change its lifecycle/status instead.</p>
      {version ? <Button className="mt-2" variant="outline" size="sm" onClick={() => open(null)}><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open original</Button> : null}
    </section>
  );
}
