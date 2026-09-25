"use client";

import { AlertTriangle, Archive, ArchiveRestore, Download, Eye, FileText, History, Loader2, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { useSelectedProject } from "@/contexts/selected-project-context";
import { canArchiveOrDeleteSourceDocuments, canManageSourceDocuments } from "@/lib/permissions";
import { scopeProjectData } from "@/lib/project-scope";
import { ACCEPT_ATTRIBUTE, DOCUMENT_TYPE_OPTIONS, MAX_SOURCE_DOCUMENT_BYTES, checkUploadCandidate, currentVersionOf, formatBytes, versionsFor } from "@/lib/source-documents";
import {
  deleteSourceDocument, openSourceDocumentVersion, setCurrentSourceDocumentVersion, setSourceDocumentArchived, uploadSourceDocument,
} from "@/lib/source-documents-client";
import type { DataStore } from "@/lib/data-store";
import type { DocumentProcessingStatus, DocumentRecord, DocumentVersion } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";

// ── Source Documents (Phase 1A) ─────────────────────────────────────────────
// Original CR / specification / design files for the current project, each
// with an immutable version history. Viewer: view/download. Manager: also
// upload documents and new versions, and choose the current version.
// Admin: also archive/restore and permanently delete (archived only).

const formatDate = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

function StatusBadge({ status }: { status: DocumentProcessingStatus | undefined }) {
  const tone = status === "Complete" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : status === "Failed" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      : status === "Queued" || status === "In Progress" ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
        : "bg-muted text-muted-foreground";
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{status ?? "—"}</span>;
}

type UploadTarget = { mode: "new" } | { mode: "version"; document: DocumentRecord };

function withDocument(data: DataStore, document: DocumentRecord, version?: DocumentVersion): DataStore {
  const documents = data.documents.some((d) => d.id === document.id)
    ? data.documents.map((d) => (d.id === document.id ? document : d))
    : [document, ...data.documents];
  const document_versions = version && !data.document_versions.some((v) => v.id === version.id)
    ? [...data.document_versions, version]
    : data.document_versions;
  return { ...data, documents, document_versions };
}

function UploadDialog({ target, projectId, onClose, onUploaded }: {
  target: UploadTarget;
  projectId: string;
  onClose: () => void;
  onUploaded: (document: DocumentRecord, version: DocumentVersion) => void;
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
      const { document, version } = await uploadSourceDocument({
        projectId, file,
        documentId: target.mode === "version" ? target.document.id : undefined,
        title: isNew ? title.trim() : undefined,
        documentType: isNew ? documentType : undefined,
        notes: isNew ? notes : undefined,
      });
      onUploaded(document, version);
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

  const mayManage = canManageSourceDocuments(user?.role);
  const mayArchive = canArchiveOrDeleteSourceDocuments(user?.role);
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

  async function run(id: string, action: () => Promise<void>) {
    setActionError(null);
    setBusyId(id);
    try { await action(); } catch (e) { setActionError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusyId(null); }
  }

  const open = (version: DocumentVersion, disposition: "inline" | "attachment") =>
    run(version.id, () => openSourceDocumentVersion(projectId, version.id, disposition));

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
      } : current);
    });
  };

  function DocumentRows({ documents }: { documents: DocumentRecord[] }) {
    return (
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/60 text-left text-xs font-semibold uppercase text-muted-foreground">
            <tr>
              {["Document", "Type", "Version", "Original file", "Uploaded", "Uploaded by", "Size", "Extraction", "Analysis", ""].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const current = currentVersionOf(document, versions);
              const history = versionsFor(document.id, versions);
              const busy = busyId === document.id || history.some((v) => v.id === busyId);
              return (
                <FragmentRows key={document.id}>
                  <tr className="border-t align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{document.document_name}</p>
                      {document.notes ? <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">{document.notes}</p> : null}
                      {document.archived_at ? <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">Archived {formatDate(document.archived_at)}</p> : null}
                    </td>
                    <td className="px-3 py-2">{document.document_type ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{current ? `v${current.version_number}` : "—"}<span className="block text-xs font-normal text-muted-foreground">{history.length} version{history.length === 1 ? "" : "s"}</span></td>
                    <td className="px-3 py-2 break-all">{current?.original_filename ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(current?.uploaded_at)}</td>
                    <td className="px-3 py-2">{current?.uploaded_by_name ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{current ? formatBytes(current.size_bytes) : "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={current?.extraction_status} /></td>
                    <td className="px-3 py-2"><StatusBadge status={current?.analysis_status} /></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        {busy ? <Loader2 className="m-2 h-4 w-4 animate-spin text-muted-foreground" aria-label="Working" /> : null}
                        {current ? <Button variant="ghost" size="icon" title="View" aria-label={`View ${document.document_name}`} onClick={() => open(current, "inline")}><Eye className="h-4 w-4" aria-hidden="true" /></Button> : null}
                        {current ? <Button variant="ghost" size="icon" title="Download" aria-label={`Download ${document.document_name}`} onClick={() => open(current, "attachment")}><Download className="h-4 w-4" aria-hidden="true" /></Button> : null}
                        <Button variant="ghost" size="icon" title="Version history" aria-label={`Version history for ${document.document_name}`} onClick={() => setHistoryFor(historyFor === document.id ? null : document.id)}><History className="h-4 w-4" aria-hidden="true" /></Button>
                        {mayManage && !document.archived_at ? (
                          <Button variant="outline" size="sm" onClick={() => setUploadTarget({ mode: "version", document })}><Upload className="h-3.5 w-3.5" aria-hidden="true" />Upload New Version</Button>
                        ) : null}
                        {mayArchive ? (
                          <Button variant="ghost" size="icon" title={document.archived_at ? "Restore" : "Archive"} aria-label={document.archived_at ? "Restore" : "Archive"} onClick={() => toggleArchived(document)}>
                            {document.archived_at ? <ArchiveRestore className="h-4 w-4" aria-hidden="true" /> : <Archive className="h-4 w-4" aria-hidden="true" />}
                          </Button>
                        ) : null}
                        {mayArchive && document.archived_at ? (
                          <Button variant="ghost" size="icon" title="Delete permanently" aria-label="Delete permanently" onClick={() => remove(document)}><Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" /></Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {historyFor === document.id ? (
                    <tr className="border-t bg-muted/30">
                      <td colSpan={10} className="px-3 py-3">
                        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Version history</p>
                        <table className="w-full text-xs">
                          <tbody>
                            {history.map((version) => (
                              <tr key={version.id} className="border-t first:border-t-0">
                                <td className="py-1.5 pr-3 font-medium">v{version.version_number}</td>
                                <td className="py-1.5 pr-3 break-all">{version.original_filename}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(version.uploaded_at)}</td>
                                <td className="py-1.5 pr-3">{version.uploaded_by_name}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">{formatBytes(version.size_bytes)}</td>
                                <td className="py-1.5 pr-3 font-mono" title={version.sha256}>sha256 {version.sha256.slice(0, 12)}…</td>
                                <td className="py-1.5 pr-3"><StatusBadge status={version.extraction_status} /> <StatusBadge status={version.analysis_status} /></td>
                                <td className="py-1.5 text-right whitespace-nowrap">
                                  {version.id === document.current_version_id ? (
                                    <span className="mr-2 rounded bg-primary/10 px-2 py-0.5 font-semibold text-primary">Current</span>
                                  ) : mayManage && !document.archived_at ? (
                                    <Button variant="outline" size="sm" className="mr-1" onClick={() => makeCurrent(document, version)}>Make current</Button>
                                  ) : null}
                                  <Button variant="ghost" size="icon" title="View" aria-label={`View v${version.version_number}`} onClick={() => open(version, "inline")}><Eye className="h-4 w-4" aria-hidden="true" /></Button>
                                  <Button variant="ghost" size="icon" title="Download" aria-label={`Download v${version.version_number}`} onClick={() => open(version, "attachment")}><Download className="h-4 w-4" aria-hidden="true" /></Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null}
                </FragmentRows>
              );
            })}
          </tbody>
        </table>
      </div>
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

      {uploadTarget ? (
        <UploadDialog
          target={uploadTarget}
          projectId={projectId}
          onClose={() => setUploadTarget(null)}
          onUploaded={(document, version) => {
            setData((current) => (current ? withDocument(current, document, version) : current));
            setUploadTarget(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
