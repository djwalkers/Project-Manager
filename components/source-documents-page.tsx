"use client";

import { AlertTriangle, Archive, ArchiveRestore, Download, Eye, FileSearch, FileText, History, Loader2, MoreHorizontal, RotateCcw, Trash2, Upload, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { ExtractionViewer } from "@/components/extraction-viewer";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { useSelectedProject } from "@/contexts/selected-project-context";
import { canArchiveOrDeleteSourceDocuments, canManageSourceDocuments } from "@/lib/permissions";
import { scopeProjectData } from "@/lib/project-scope";
import { ACCEPT_ATTRIBUTE, DOCUMENT_TYPE_OPTIONS, EXTRACTION_ERROR_LABELS, MAX_SOURCE_DOCUMENT_BYTES, canQueueExtraction, canReextract, checkUploadCandidate, currentVersionOf, fileSummary, formatBytes, jobsForVersion, latestJobFor, latestSuccessfulJobFor, versionsFor } from "@/lib/source-documents";
import {
  deleteSourceDocument, loadAvailableExtractorVersion, openSourceDocumentVersion, queueSourceDocumentExtraction, setCurrentSourceDocumentVersion, setSourceDocumentArchived, uploadSourceDocument,
} from "@/lib/source-documents-client";
import type { DataStore } from "@/lib/data-store";
import type { DocumentRecord, DocumentVersion, ExtractionJob, ExtractionStatus } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";

// ── Source Documents (Phase 1A) ─────────────────────────────────────────────
// Original CR / specification / design files for the current project, each
// with an immutable version history. Viewer: view/download. Manager: also
// upload documents and new versions, and choose the current version.
// Admin: also archive/restore and permanently delete (archived only).
// Extraction (Phase 1B): each version shows its canonical extraction_status;
// everyone may view a completed extraction; Manager/Admin may start or retry.

const formatDate = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

function StatusBadge({ status }: { status: string | undefined }) {
  const tone = status === "Complete" || status === "Completed" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : status === "Completed with warnings" ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
      : status === "Failed" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
        : status === "Queued" || status === "In Progress" || status === "Running" ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
          : "bg-muted text-muted-foreground";
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{status ?? "—"}</span>;
}

type UploadTarget = { mode: "new" } | { mode: "version"; document: DocumentRecord };

function withDocument(data: DataStore, document: DocumentRecord, version?: DocumentVersion, job?: ExtractionJob | null): DataStore {
  const documents = data.documents.some((d) => d.id === document.id)
    ? data.documents.map((d) => (d.id === document.id ? document : d))
    : [document, ...data.documents];
  const document_versions = version && !data.document_versions.some((v) => v.id === version.id)
    ? [...data.document_versions, version]
    : data.document_versions;
  return withJob({ ...data, documents, document_versions }, job ?? null);
}

/** Adds/replaces an extraction job and mirrors its state onto the version's canonical status. */
function withJob(data: DataStore, job: ExtractionJob | null): DataStore {
  if (!job) return data;
  const extraction_jobs = [...data.extraction_jobs.filter((j) => j.id !== job.id), job];
  const successStatus = (j: ExtractionJob): ExtractionStatus => (j.outcome === "completed_with_warnings" ? "Completed with warnings" : "Completed");
  // Mirrors the database (037): a failed run leaves the last successful status in place.
  const previousSuccess = latestSuccessfulJobFor(job.document_version_id, extraction_jobs);
  const status: ExtractionStatus = job.status === "Completed" ? successStatus(job)
    : job.status === "Failed" && previousSuccess ? successStatus(previousSuccess) : job.status;
  const document_versions = data.document_versions.map((v) => (v.id === job.document_version_id ? { ...v, extraction_status: status } : v));
  return { ...data, extraction_jobs, document_versions };
}

function UploadDialog({ target, projectId, onClose, onUploaded }: {
  target: UploadTarget;
  projectId: string;
  onClose: () => void;
  onUploaded: (document: DocumentRecord, version: DocumentVersion, job: ExtractionJob | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState<string>("Functional Specification");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = target.mode === "new";

  function pick(next: File | null) {
    setError(null);
    setFile(next);
    if (!next) return;
    const check = checkUploadCandidate({ filename: next.name, contentType: next.type, size: next.size });
    if (!check.ok) setError(check.error);
    if (isNew && !title) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) { setError("Choose a PDF or DOCX file to upload."); return; }
    const check = checkUploadCandidate({ filename: file.name, contentType: file.type, size: file.size });
    if (!check.ok) { setError(check.error); return; }
    if (isNew && !title.trim()) { setError("A title is required."); return; }
    setBusy(true);
    setError(null);
    try {
      const { document, version, extraction_job } = await uploadSourceDocument({
        projectId, file,
        documentId: target.mode === "version" ? target.document.id : undefined,
        title: isNew ? title.trim() : undefined,
        documentType: isNew ? documentType : undefined,
        notes: isNew ? notes : undefined,
      });
      onUploaded(document, version, extraction_job);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35">
      <div className="h-full w-full overflow-y-auto border-l bg-background shadow-2xl sm:max-w-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-5 py-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{isNew ? "Upload" : "Upload New Version"}</p>
            <h2 className="text-lg font-semibold">{isNew ? "Source Document" : target.document.document_name}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" disabled={busy}><X className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
        <form className="space-y-4 p-5" onSubmit={submit}>
          {error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">{error}</div> : null}
          <label className="block space-y-2 text-sm font-medium">
            <span>File <span className="text-destructive" aria-hidden="true">*</span></span>
            <Input type="file" accept={ACCEPT_ATTRIBUTE} onChange={(event) => pick(event.target.files?.[0] ?? null)} disabled={busy} />
            <span className="block text-xs font-normal text-muted-foreground">PDF or DOCX, up to {formatBytes(MAX_SOURCE_DOCUMENT_BYTES)}. The original file is stored unchanged and never overwritten.</span>
          </label>
          {isNew ? (
            <>
              <label className="block space-y-2 text-sm font-medium">
                <span>Title <span className="text-destructive" aria-hidden="true">*</span></span>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={busy} />
              </label>
              <label className="block space-y-2 text-sm font-medium">
                <span>Document type</span>
                <Select value={documentType} onChange={(event) => setDocumentType(event.target.value)} disabled={busy}>
                  {DOCUMENT_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
              </label>
              <label className="block space-y-2 text-sm font-medium">
                <span>Description / notes</span>
                <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} disabled={busy} />
              </label>
            </>
          ) : (
            <p className="rounded-md border bg-muted/60 p-3 text-sm text-muted-foreground">
              The new file becomes the next version and the current one. Earlier versions stay available.
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !file}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SourceDocumentsPage() {
  const { data, setData, error, reload } = useProjectData();
  const { user } = useAuth();
  const { project: activeProject } = useSelectedProject(data);
  const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ title: string; version: DocumentVersion } | null>(null);
  const [availableExtractor, setAvailableExtractor] = useState<string | null>(null);

  const mayManage = canManageSourceDocuments(user?.role);
  const mayArchive = canArchiveOrDeleteSourceDocuments(user?.role);

  // The extractor version the local worker actually reports — the basis for
  // "Re-extract with newer extractor". Only Managers/Admins need (or can read) it.
  useEffect(() => {
    if (!mayManage) return;
    let active = true;
    loadAvailableExtractorVersion().then((v) => { if (active) setAvailableExtractor(v); }).catch(() => undefined);
    return () => { active = false; };
  }, [mayManage]);
  const pageData = data && activeProject ? scopeProjectData(data, activeProject) : null;

  const [active, archived] = useMemo(() => {
    const docs = [...(pageData?.documents ?? [])].sort((a, b) => a.document_name.localeCompare(b.document_name, undefined, { numeric: true }));
    return [docs.filter((d) => !d.archived_at), docs.filter((d) => d.archived_at)];
  }, [pageData?.documents]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!activeProject || !pageData) {
    return <AppShell><EmptyState title="No project selected" description="Open a project from the Portfolio page before working with its source documents." icon={AlertTriangle} /></AppShell>;
  }
  const projectId = activeProject.id;
  const versions = pageData.document_versions;
  const jobs = pageData.extraction_jobs;

  async function run(id: string, action: () => Promise<void>) {
    setActionError(null);
    setBusyId(id);
    try { await action(); } catch (e) { setActionError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusyId(null); }
  }

  const open = (version: DocumentVersion, disposition: "inline" | "attachment") =>
    run(version.id, () => openSourceDocumentVersion(projectId, version.id, disposition));

  const queueExtraction = (version: DocumentVersion, mode: "manual" | "upgrade" = "manual") => run(version.id, async () => {
    const { job } = await queueSourceDocumentExtraction(projectId, version.id, mode);
    setData((current) => (current ? withJob(current, job) : current));
  });

  // Extraction state + actions for one version: status badge, failure reason,
  // View extraction (everyone; the newest SUCCESSFUL run by default),
  // Extract / Retry, and Re-extract with a newer extractor (Manager+ only).
  function ExtractionControls({ document, version, compact }: { document: DocumentRecord; version: DocumentVersion; compact?: boolean }) {
    const job = latestJobFor(version.id, jobs);
    const success = latestSuccessfulJobFor(version.id, jobs);
    const failedAfterSuccess = job?.status === "Failed" && Boolean(success);
    return (
      <div className={compact ? "inline-flex flex-wrap items-center gap-1" : "flex flex-col items-start gap-1"}>
        <StatusBadge status={version.extraction_status} />
        {job?.status === "Failed" && !compact ? (
          <span className="max-w-[14rem] text-xs text-destructive" title={job.error_message ?? undefined}>
            {failedAfterSuccess ? "Re-extraction failed — the previous extraction is still in use" : EXTRACTION_ERROR_LABELS[job.error_category ?? ""] ?? "Extraction failed"}
          </span>
        ) : null}
        {success && !compact ? <span className="text-xs text-muted-foreground">extractor {success.extractor_version}</span> : null}
        {job && (success || job.status === "Failed") ? (
          <button type="button" className="inline-flex items-center gap-1 text-xs text-primary underline" onClick={() => setViewing({ title: document.document_name, version })}>
            <FileSearch className="h-3 w-3" aria-hidden="true" />{success ? "View extraction" : "Details"}
          </button>
        ) : null}
        {mayManage && !document.archived_at && canQueueExtraction(job) ? (
          <button type="button" className="inline-flex items-center gap-1 text-xs text-primary underline" onClick={() => queueExtraction(version)}>
            <RotateCcw className="h-3 w-3" aria-hidden="true" />{job ? "Retry extraction" : "Extract"}
          </button>
        ) : null}
        {mayManage && !document.archived_at && !canQueueExtraction(job) && canReextract(version.id, jobs, availableExtractor) ? (
          <button type="button" className="inline-flex items-center gap-1 text-xs text-primary underline" onClick={() => queueExtraction(version, "upgrade")}>
            <RotateCcw className="h-3 w-3" aria-hidden="true" />Re-extract with newer extractor ({availableExtractor})
          </button>
        ) : null}
      </div>
    );
  }

  const makeCurrent = (document: DocumentRecord, version: DocumentVersion) => run(version.id, async () => {
    const { document: saved } = await setCurrentSourceDocumentVersion(projectId, document.id, version.id);
    setData((current) => (current ? withDocument(current, saved) : current));
  });

  const toggleArchived = (document: DocumentRecord) => run(document.id, async () => {
    const { document: saved } = await setSourceDocumentArchived(projectId, document.id, !document.archived_at);
    setData((current) => (current ? withDocument(current, saved) : current));
  });

  const remove = (document: DocumentRecord) => {
    if (!window.confirm(`Permanently delete "${document.document_name}" and all ${versionsFor(document.id, versions).length} of its versions? This cannot be undone.`)) return;
    void run(document.id, async () => {
      await deleteSourceDocument(projectId, document.id);
      setData((current) => current ? {
        ...current,
        documents: current.documents.filter((d) => d.id !== document.id),
        document_versions: current.document_versions.filter((v) => v.document_id !== document.id),
        extraction_jobs: current.extraction_jobs.filter((j) => !versionsFor(document.id, current.document_versions).some((v) => v.id === j.document_version_id)),
      } : current);
    });
  };

  // Secondary, role-appropriate actions for one document, behind "⋯".
  // Viewers get Download and Version history only.
  function documentMenuItems(document: DocumentRecord, current: DocumentVersion | null): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    if (current) items.push({ label: "Download original", icon: Download, onSelect: () => open(current, "attachment") });
    if (mayManage && !document.archived_at) items.push({ label: "Upload New Version", icon: Upload, onSelect: () => setUploadTarget({ mode: "version", document }) });
    items.push({ label: historyFor === document.id ? "Hide version history" : "Version history", icon: History, onSelect: () => setHistoryFor(historyFor === document.id ? null : document.id) });
    if (mayArchive) items.push({ label: document.archived_at ? "Restore" : "Archive", icon: document.archived_at ? ArchiveRestore : Archive, onSelect: () => toggleArchived(document), separated: true });
    if (mayArchive && document.archived_at) items.push({ label: "Delete permanently", icon: Trash2, onSelect: () => remove(document), destructive: true });
    return items;
  }

  function DocumentTitle({ document, current }: { document: DocumentRecord; current: DocumentVersion | null }) {
    const tooltip = current ? `${document.document_name}\n${current.original_filename}` : document.document_name;
    return (
      <div className="min-w-0">
        <p className="line-clamp-2 break-words font-medium" title={tooltip}>{document.document_name}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={current?.original_filename}>
          {[document.document_type, current ? fileSummary(current) : null].filter(Boolean).join(" · ") || "—"}
        </p>
        {document.notes ? <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={document.notes}>{document.notes}</p> : null}
        {document.archived_at ? <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">Archived {formatDate(document.archived_at)}</p> : null}
      </div>
    );
  }

  const VersionSummary = ({ document, current }: { document: DocumentRecord; current: DocumentVersion | null }) => {
    const count = versionsFor(document.id, versions).length;
    return <p className="whitespace-nowrap font-medium">{current ? `v${current.version_number}` : "—"}<span className="block text-xs font-normal text-muted-foreground">{count} version{count === 1 ? "" : "s"}</span></p>;
  };

  const Uploaded = ({ current }: { current: DocumentVersion | null }) => (
    <p className="min-w-0"><span className="block whitespace-nowrap">{formatDate(current?.uploaded_at)}</span><span className="block truncate text-xs text-muted-foreground" title={current?.uploaded_by_name ?? undefined}>{current?.uploaded_by_name ?? "—"}</span></p>
  );

  function PrimaryActions({ document, current, busy }: { document: DocumentRecord; current: DocumentVersion | null; busy: boolean }) {
    return (
      <div className="flex items-center justify-end gap-1">
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Working" /> : null}
        {current ? (
          <Button variant="outline" size="sm" className="whitespace-nowrap" aria-label={`View original of ${document.document_name}`} onClick={() => open(current, "inline")}>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />View original
          </Button>
        ) : null}
        <RowMenu label={`More actions for ${document.document_name}`} items={documentMenuItems(document, current)} />
      </div>
    );
  }

  // Full version history (every version, with its own extraction state).
  function VersionHistory({ document }: { document: DocumentRecord }) {
    const history = versionsFor(document.id, versions);
    return (
      <div>
        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Version history</p>
        <ul className="divide-y text-xs">
          {history.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2">
              <span className="w-8 font-medium">v{version.version_number}</span>
              <span className="min-w-[10rem] max-w-[22rem] flex-1 truncate" title={version.original_filename}>{version.original_filename}</span>
              <span className="whitespace-nowrap">{formatDate(version.uploaded_at)} · {version.uploaded_by_name}</span>
              <span className="whitespace-nowrap">{fileSummary(version)}</span>
              <span className="whitespace-nowrap font-mono" title={version.sha256}>sha256 {version.sha256.slice(0, 12)}…</span>
              <span className="inline-flex items-center gap-1"><ExtractionControls document={document} version={version} compact /> <StatusBadge status={version.analysis_status} /></span>
              <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap">
                {version.id === document.current_version_id ? (
                  <span className="mr-1 rounded bg-primary/10 px-2 py-0.5 font-semibold text-primary">Current</span>
                ) : mayManage && !document.archived_at ? (
                  <Button variant="outline" size="sm" onClick={() => makeCurrent(document, version)}>Make current</Button>
                ) : null}
                <Button variant="ghost" size="icon" title="View original" aria-label={`View v${version.version_number}`} onClick={() => open(version, "inline")}><Eye className="h-4 w-4" aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" title="Download original" aria-label={`Download v${version.version_number}`} onClick={() => open(version, "attachment")}><Download className="h-4 w-4" aria-hidden="true" /></Button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Wide screens (xl+): a fixed-layout table where the document column takes
  // the spare width. Narrower screens: one card per document, so nothing is
  // squeezed into one-word-per-line columns.
  function DocumentRows({ documents }: { documents: DocumentRecord[] }) {
    const rows = documents.map((document) => {
      const current = currentVersionOf(document, versions);
      const busy = busyId === document.id || versionsFor(document.id, versions).some((v) => v.id === busyId);
      return { document, current, busy };
    });
    const extraction = (document: DocumentRecord, current: DocumentVersion | null) =>
      current ? <ExtractionControls document={document} version={current} /> : <StatusBadge status={undefined} />;
    return (
      <>
        <div className="hidden rounded-lg border bg-card xl:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-[5.5rem]" />
              <col className="w-[10rem]" />
              <col className="w-[12rem]" />
              <col className="w-[9rem]" />
              <col className="w-[11rem]" />
            </colgroup>
            <thead className="bg-muted/60 text-left text-xs font-semibold uppercase text-muted-foreground">
              <tr>
                {["Document", "Version", "Uploaded", "Extraction", "Analysis", "Actions"].map((h) => (
                  <th key={h} className={`px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg ${h === "Actions" ? "text-right" : ""}`}>{h === "Actions" ? <span className="sr-only">{h}</span> : h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ document, current, busy }) => (
                <FragmentRows key={document.id}>
                  <tr className="border-t align-top">
                    <td className="px-3 py-2.5"><DocumentTitle document={document} current={current} /></td>
                    <td className="px-3 py-2.5"><VersionSummary document={document} current={current} /></td>
                    <td className="px-3 py-2.5"><Uploaded current={current} /></td>
                    <td className="px-3 py-2.5">{extraction(document, current)}</td>
                    <td className="px-3 py-2.5"><StatusBadge status={current?.analysis_status} /></td>
                    <td className="px-3 py-2.5"><PrimaryActions document={document} current={current} busy={busy} /></td>
                  </tr>
                  {historyFor === document.id ? (
                    <tr className="border-t bg-muted/30">
                      <td colSpan={6} className="px-3 py-3"><VersionHistory document={document} /></td>
                    </tr>
                  ) : null}
                </FragmentRows>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="space-y-3 xl:hidden">
          {rows.map(({ document, current, busy }) => (
            <li key={document.id} className="rounded-lg border bg-card p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <DocumentTitle document={document} current={current} />
                <div className="shrink-0"><PrimaryActions document={document} current={current} busy={busy} /></div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Version</dt><dd className="mt-0.5"><VersionSummary document={document} current={current} /></dd></div>
                <div className="min-w-0"><dt className="text-xs font-semibold uppercase text-muted-foreground">Uploaded</dt><dd className="mt-0.5"><Uploaded current={current} /></dd></div>
                <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Extraction</dt><dd className="mt-0.5">{extraction(document, current)}</dd></div>
                <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Analysis</dt><dd className="mt-0.5"><StatusBadge status={current?.analysis_status} /></dd></div>
              </dl>
              {historyFor === document.id ? <div className="mt-3 border-t pt-3"><VersionHistory document={document} /></div> : null}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Source Documents</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            The original CR, specification and design documents for {activeProject.name}. Every upload is kept as an immutable version; the current version is the authoritative source.
          </p>
        </div>
        {mayManage ? (
          <Button onClick={() => setUploadTarget({ mode: "new" })}><Upload className="h-4 w-4" aria-hidden="true" />Upload Source Document</Button>
        ) : null}
      </div>

      {actionError ? <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">{actionError}</div> : null}

      {active.length === 0 ? (
        <EmptyState
          title="No source documents yet"
          description={mayManage ? "Upload the project's CR, functional specification or design document (PDF or DOCX)." : "No source documents have been uploaded for this project."}
          icon={FileText}
          action={mayManage ? () => setUploadTarget({ mode: "new" }) : undefined}
        />
      ) : <DocumentRows documents={active} />}

      {archived.length ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Archived</h3>
          <DocumentRows documents={archived} />
        </div>
      ) : null}

      {viewing ? <ExtractionViewer title={viewing.title} version={viewing.version} runs={jobsForVersion(viewing.version.id, jobs)} onClose={() => setViewing(null)} /> : null}

      {uploadTarget ? (
        <UploadDialog
          target={uploadTarget}
          projectId={projectId}
          onClose={() => setUploadTarget(null)}
          onUploaded={(document, version, job) => {
            setData((current) => (current ? withDocument(current, document, version, job) : current));
            setUploadTarget(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}

type RowMenuItem = { label: string; icon: LucideIcon; onSelect: () => void; destructive?: boolean; separated?: boolean };

/** "⋯" overflow menu for a row's secondary actions (closes on select, outside click or Escape). */
function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); container.current?.querySelector<HTMLButtonElement>("button")?.focus(); };
  return (
    <div ref={container} className="relative">
      <Button variant="ghost" size="icon" title="More actions" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </Button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={label}
            className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-md border bg-card p-1 shadow-lg"
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                autoFocus={item === items[0]}
                className={`flex w-full items-center gap-2 whitespace-nowrap rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none ${item.separated ? "mt-1 border-t pt-2" : ""} ${item.destructive ? "text-destructive" : ""}`}
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
