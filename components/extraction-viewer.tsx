"use client";

import { AlertTriangle, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXTRACTION_ERROR_LABELS, latestSuccessfulJobFor } from "@/lib/source-documents";
import { loadExtractionFragments, openSourceDocumentVersion } from "@/lib/source-documents-client";
import type { DocumentVersion, ExtractionJob, SourceFragment } from "@/lib/types";

// Read-only view of what the deterministic extractor found for ONE
// immutable version: diagnostics, warnings, and every fragment with its
// provenance (section, pages, type). Extracted text cannot be edited — it
// records the extractor's output, for comparison against the original.

const pagesLabel = (f: SourceFragment) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `Pages ${f.page_start}–${f.page_end}` : `Page ${f.page_start}`;

const runLabel = (j: ExtractionJob) => {
  const when = j.completed_at ?? j.queued_at;
  const date = when ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(when)) : "—";
  const state = j.status === "Completed" ? (j.outcome === "completed_with_warnings" ? "Completed with warnings" : "Completed") : j.status;
  return `${date} · extractor ${j.extractor_version ?? j.requested_extractor_version ?? "—"} · ${state}${j.trigger === "upgrade" ? " · re-extraction" : ""}`;
};

/**
 * `runs` are all extraction runs of this version (newest first). The newest
 * successful run is shown by default — a newer failed run never replaces it —
 * and earlier runs stay selectable as read-only history.
 */
export function ExtractionViewer({ title, version, runs, onClose }: {
  title: string;
  version: DocumentVersion;
  runs: ExtractionJob[];
  onClose: () => void;
}) {
  const defaultRun = latestSuccessfulJobFor(version.id, runs) ?? runs[0];
  const [selectedId, setSelectedId] = useState(defaultRun?.id ?? "");
  const job = runs.find((r) => r.id === selectedId) ?? defaultRun;
  const newerFailure = runs[0] && runs[0].status === "Failed" && defaultRun && runs[0].id !== defaultRun.id ? runs[0] : null;
  const [fragments, setFragments] = useState<SourceFragment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const isPdf = version.content_type === "application/pdf";
  const diagnostics = job.diagnostics ?? {};
  const completed = job.status === "Completed";

  useEffect(() => {
    setFragments(null);
    setError(null);
    if (!completed) return;
    let active = true;
    loadExtractionFragments(job.id)
      .then((rows) => { if (active) setFragments(rows); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Could not load the extracted content."); });
    return () => { active = false; };
  }, [job.id, completed]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!fragments || !q) return fragments ?? [];
    return fragments.filter((f) => f.text.toLowerCase().includes(q) || (f.section_heading ?? "").toLowerCase().includes(q));
  }, [fragments, filter]);

  const openOriginal = (page?: number | null) => {
    openSourceDocumentVersion(version.project_id, version.id, "inline", isPdf ? page : null).catch((e) => setError(e instanceof Error ? e.message : "Could not open the original."));
  };

  const stats = [
    diagnostics.page_count != null ? `${diagnostics.page_count} page${diagnostics.page_count === 1 ? "" : "s"}` : null,
    `${job.fragment_count ?? diagnostics.fragment_count ?? 0} fragments`,
    diagnostics.char_count != null ? `${diagnostics.char_count.toLocaleString("en-GB")} characters` : null,
    diagnostics.heading_count != null ? `${diagnostics.heading_count} headings` : null,
    diagnostics.table_count != null ? `${diagnostics.table_count} tables` : null,
    diagnostics.field_count ? `${diagnostics.field_count} fields` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" role="dialog" aria-label={`Extracted content of ${title} v${version.version_number}`}>
      <div className="flex h-full w-full flex-col border-l bg-background shadow-2xl sm:max-w-3xl">
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">Extracted content · read-only</p>
            <h2 className="truncate text-lg font-semibold">{title} — v{version.version_number}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {version.original_filename} · extractor {job.extractor_version ?? "—"} · {job.completed_at ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(job.completed_at)) : "—"}
            </p>
            {completed ? <p className="mt-1 text-xs text-muted-foreground">{stats}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => openOriginal(null)}><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open original</Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" aria-hidden="true" /></Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {runs.length > 1 ? (
            <label className="mb-4 block text-sm font-medium">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Extraction run</span>
              <select className="mt-1 block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={job?.id ?? ""} onChange={(e) => setSelectedId(e.target.value)} aria-label="Extraction run">
                {runs.map((r) => <option key={r.id} value={r.id}>{runLabel(r)}{r.id === defaultRun?.id ? " (default)" : ""}</option>)}
              </select>
            </label>
          ) : null}
          {newerFailure && job?.id !== newerFailure.id ? (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              A newer extraction run failed ({EXTRACTION_ERROR_LABELS[newerFailure.error_category ?? ""] ?? "failed"}). This is the most recent successful extraction.
            </div>
          ) : null}
          {error ? <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}
          {job.status === "Failed" ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <p className="font-semibold text-destructive">{EXTRACTION_ERROR_LABELS[job.error_category ?? ""] ?? "Extraction failed"}</p>
              {job.error_message ? <p className="mt-1 text-muted-foreground">{job.error_message}</p> : null}
            </div>
          ) : null}
          {diagnostics.warnings?.length ? (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />Extraction warnings</p>
              <ul className="mt-1 list-disc pl-5">{diagnostics.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          ) : null}
          {diagnostics.chrome_lines?.length ? (
            <details className="mb-4 rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {diagnostics.chrome_lines.length} page header/footer line{diagnostics.chrome_lines.length === 1 ? "" : "s"} excluded as document chrome
              </summary>
              <p className="mt-1 text-xs text-muted-foreground">Repeated printed headers, footers, page counters and export stamps are set aside deterministically and are not part of any fragment.</p>
              <ul className="mt-2 space-y-1 text-xs">
                {diagnostics.chrome_lines.map((c, i) => <li key={i}><span className="text-muted-foreground">p.{c.page} {c.position}:</span> {c.text}</li>)}
              </ul>
            </details>
          ) : null}
          {completed && !fragments && !error ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading extracted content…</p> : null}
          {fragments ? (
            <>
              <Input placeholder="Filter fragments…" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-4" aria-label="Filter fragments" />
              <ol className="space-y-4">
                {shown.map((f) => (
                  <li key={f.id} className="rounded-md border bg-card p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold">{f.section_heading ?? "No section heading"}</p>
                      <p className="text-xs text-muted-foreground">
                        #{f.sequence} · {f.fragment_type}{pagesLabel(f) ? ` · ${pagesLabel(f)}` : ""}
                        {isPdf && f.page_start ? <button type="button" className="ml-2 underline" onClick={() => openOriginal(f.page_start)}>view page</button> : null}
                      </p>
                    </div>
                    {f.section_path.length > 1 ? <p className="text-xs text-muted-foreground">{f.section_path.join(" › ")}</p> : null}
                    {f.fragment_type === "table" && f.metadata.table ? (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full border text-xs">
                          <tbody>
                            {f.metadata.table.rows.map((row, r) => (
                              <tr key={r} className={r === 0 ? "bg-muted/60 font-semibold" : "border-t"}>
                                {row.map((cell, c) => <td key={c} className="border-l px-2 py-1 align-top first:border-l-0">{cell}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{f.text}</p>
                    )}
                  </li>
                ))}
              </ol>
              {filter && shown.length === 0 ? <p className="text-sm text-muted-foreground">No fragments match “{filter}”.</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
