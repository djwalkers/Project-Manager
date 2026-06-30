"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit3,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { deleteRecord, saveRecord } from "@/lib/supabase/data-store";
import { useProjectData } from "@/lib/use-project-data";
import { buildCompactContext } from "@/lib/meeting-intelligence/prompt";
import { estimateChunkCount, CHUNK_SIZE } from "@/lib/meeting-intelligence/chunker";
import { matchSuggestionsToExisting, type EnrichedSuggestion } from "@/lib/meeting-intelligence/matcher";
import type {
  MeetingIntelligence,
  MeetingSuggestion,
  SuggestionEntityType,
  SuggestionAction,
} from "@/lib/types";
import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

// ── Types ─────────────────────────────────────────────────────────────────────

type AIMeta = { provider: string; model: string | null; enabled: boolean; key_configured: boolean } | null;

type Stage = { label: string; done: boolean };

type AnalyseErrorInfo = {
  message: string;
  isRateLimit?: boolean;
  retryAfter?: number | null;
  hint?: string | null;
  failedChunk?: number;
  totalChunks?: number;
};

type SSEEvent =
  | { type: "log"; label: string }
  | { type: "result"; summary: string; suggestions: AIAnalysisResponse["suggestions"] }
  | { type: "rate_limit"; message: string; retryAfter: number | null; hint: string; failedChunk: number; totalChunks: number }
  | { type: "error"; message: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

const ENTITY_LABELS: Record<SuggestionEntityType, string> = {
  action: "Action",
  decision: "Decision",
  risk: "Risk",
  requirement: "Requirement",
  discovery_question: "Discovery Question",
  dependency: "Dependency",
  milestone: "Milestone",
  deliverable: "Deliverable",
  test_case: "Test Case",
  acceptance_criterion: "Acceptance Criterion",
  evidence: "Evidence",
  project_update: "Project Update",
  general_note: "Note",
};

const ENTITY_ORDER: SuggestionEntityType[] = [
  "action", "decision", "risk", "dependency", "milestone",
  "requirement", "acceptance_criterion", "evidence", "test_case",
  "deliverable", "discovery_question", "project_update", "general_note",
];

const ACTION_LABELS: Record<SuggestionAction, string> = {
  create: "Create",
  update: "Update",
  close: "Close",
  note: "Note",
};

const ACTION_COLORS: Record<SuggestionAction, string> = {
  create: "bg-green-100 text-green-800 border-green-200",
  update: "bg-blue-100 text-blue-800 border-blue-200",
  close: "bg-slate-100 text-slate-700 border-slate-200",
  note: "bg-purple-100 text-purple-800 border-purple-200",
};

const CONFIDENCE_COLORS = {
  High: "text-green-700",
  Medium: "text-amber-600",
  Low: "text-slate-500",
};

const STATUS_BADGE: Record<string, string> = {
  Draft: "border-slate-200 bg-slate-50 text-slate-700",
  Analysed: "border-amber-200 bg-amber-50 text-amber-700",
  Applied: "border-green-200 bg-green-50 text-green-700",
  Archived: "border-muted bg-muted/40 text-muted-foreground",
};

function parseSSEBuffer(buffer: string): { events: SSEEvent[]; remaining: string } {
  const parts = buffer.split("\n\n");
  const remaining = parts.pop() ?? "";
  const events: SSEEvent[] = [];
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    } catch { /* ignore malformed */ }
  }
  return { events, remaining };
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, setData, error, reload } = useProjectData();

  const [showRaw, setShowRaw] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [analyseError, setAnalyseError] = useState<AnalyseErrorInfo | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [aiMeta, setAIMeta] = useState<AIMeta>(null);

  // Per-suggestion edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});

  // Load AI provider meta once
  useEffect(() => {
    void fetch("/api/ai-settings")
      .then((r) => r.ok ? r.json() as Promise<AIMeta> : null)
      .then((meta) => { if (meta) setAIMeta(meta); })
      .catch(() => null);
  }, []);

  const meeting = useMemo(
    () => (data?.meeting_intelligence ?? []).find((m) => m.id === id) as MeetingIntelligence | undefined,
    [data, id],
  );
  const suggestions = useMemo(
    () => (data?.meeting_suggestions ?? []).filter((s) => s.meeting_id === id) as MeetingSuggestion[],
    [data, id],
  );
  const pendingSuggestions = useMemo(() => suggestions.filter((s) => s.status === "Pending"), [suggestions]);
  const appliedSuggestions = useMemo(
    () => suggestions.filter((s) => ["Accepted", "Applied"].includes(s.status)),
    [suggestions],
  );

  const groupedPending = useMemo(() => {
    const groups: Partial<Record<SuggestionEntityType, MeetingSuggestion[]>> = {};
    for (const s of pendingSuggestions) {
      if (!groups[s.entity_type]) groups[s.entity_type] = [];
      groups[s.entity_type]!.push(s);
    }
    return groups;
  }, [pendingSuggestions]);

  const previewGroups = useMemo(() => {
    const groups: Partial<Record<SuggestionEntityType, { create: number; update: number; close: number; note: number }>> = {};
    for (const s of pendingSuggestions) {
      if (!groups[s.entity_type]) groups[s.entity_type] = { create: 0, update: 0, close: 0, note: 0 };
      const g = groups[s.entity_type]!;
      if (s.action === "create") g.create++;
      else if (s.action === "update") g.update++;
      else if (s.action === "close") g.close++;
      else if (s.action === "note") g.note++;
    }
    return groups;
  }, [pendingSuggestions]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!meeting) {
    return (
      <AppShell>
        <p className="text-sm text-muted-foreground">Meeting not found.</p>
      </AppShell>
    );
  }

  const meetingLength = meeting.raw_input?.length ?? 0;
  const estimatedChunks = estimateChunkCount(meetingLength);
  const isLong = meetingLength > CHUNK_SIZE;

  // ── Analyse ────────────────────────────────────────────────────────────────
  async function handleAnalyse() {
    if (!meeting || !data) return;
    if (!meeting.raw_input?.trim()) {
      setAnalyseError({ message: "No meeting notes to analyse. Please add meeting notes first." });
      return;
    }

    setAnalysing(true);
    setAnalyseError(null);
    setStages([]);

    try {
      const compactContext = buildCompactContext(data);

      const res = await fetch("/api/meeting/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compactContext, meetingText: meeting.raw_input }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setAnalyseError({ message: err.error ?? `HTTP ${res.status}` });
        return;
      }

      if (!res.body) {
        setAnalyseError({ message: "No response body from server." });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEBuffer(buffer);
        buffer = remaining;

        for (const event of events) {
          if (event.type === "log") {
            setStages((prev) => {
              // Mark any current active stage done, add new active stage
              const updated = prev.map((s) => s.done ? s : { ...s, done: true });
              return [...updated, { label: event.label, done: false }];
            });
            continue;
          }

          if (event.type === "rate_limit") {
            setAnalyseError({
              message: event.message,
              isRateLimit: true,
              retryAfter: event.retryAfter,
              hint: event.hint,
              failedChunk: event.failedChunk,
              totalChunks: event.totalChunks,
            });
            setStages((prev) => prev.map((s) => s.done ? s : { ...s, label: `${s.label} — rate limited`, done: true }));
            break outer;
          }

          if (event.type === "error") {
            setAnalyseError({ message: event.message });
            setStages((prev) => prev.map((s) => s.done ? s : { ...s, label: `${s.label} — failed`, done: true }));
            break outer;
          }

          if (event.type === "result") {
            // Mark all stages done
            setStages((prev) => prev.map((s) => ({ ...s, done: true })));

            const enriched: EnrichedSuggestion[] = matchSuggestionsToExisting(event.suggestions, data);

            const updatedMeeting = await saveRecord("meeting_intelligence", {
              ...meeting,
              ai_summary: event.summary,
              processing_status: "Analysed",
            }) as MeetingIntelligence;

            const oldPending = suggestions.filter((s) => s.status === "Pending");
            for (const s of oldPending) {
              await deleteRecord("meeting_suggestions", s.id);
            }

            const saved: MeetingSuggestion[] = [];
            for (const s of enriched) {
              const rec = await saveRecord("meeting_suggestions", {
                project_id: meeting.project_id,
                meeting_id: meeting.id,
                entity_type: s.entity_type,
                action: s.action,
                title: s.title,
                description: s.description,
                confidence: s.confidence,
                reason: s.reason,
                status: "Pending",
                existing_record_id: s.matched_existing_id,
                existing_record_ref: s.matched_existing_ref ?? s.existing_record_ref,
                data_payload: s.data_payload,
                feedback: null,
              }) as MeetingSuggestion;
              saved.push(rec);
            }

            setData((prev) => {
              if (!prev) return prev;
              const meetings = (prev.meeting_intelligence ?? []).map((m) =>
                m.id === id ? updatedMeeting : m,
              );
              const otherSuggestions = (prev.meeting_suggestions ?? []).filter(
                (s) => s.meeting_id !== id || s.status !== "Pending",
              );
              return {
                ...prev,
                meeting_intelligence: meetings,
                meeting_suggestions: [...otherSuggestions, ...saved],
              };
            });

            break outer;
          }
        }
      }
    } catch (e) {
      setAnalyseError({ message: e instanceof Error ? e.message : "Analysis failed." });
      setStages((prev) => prev.map((s) => s.done ? s : { ...s, done: true }));
    } finally {
      setAnalysing(false);
    }
  }

  // ── Accept / Reject / Edit ─────────────────────────────────────────────────
  async function handleAccept(s: MeetingSuggestion) {
    const updated = await saveRecord("meeting_suggestions", { ...s, status: "Accepted" }) as MeetingSuggestion;
    setData((prev) => prev ? {
      ...prev,
      meeting_suggestions: (prev.meeting_suggestions ?? []).map((x) => x.id === s.id ? updated : x),
    } : prev);
  }

  async function handleReject(s: MeetingSuggestion) {
    const updated = await saveRecord("meeting_suggestions", {
      ...s, status: "Rejected", feedback: rejectNotes[s.id] ?? null,
    }) as MeetingSuggestion;
    setData((prev) => prev ? {
      ...prev,
      meeting_suggestions: (prev.meeting_suggestions ?? []).map((x) => x.id === s.id ? updated : x),
    } : prev);
    setRejectNotes((n) => { const c = { ...n }; delete c[s.id]; return c; });
  }

  async function handleSaveEdit(s: MeetingSuggestion) {
    const updated = await saveRecord("meeting_suggestions", {
      ...s, title: editTitle, description: editDesc || null, status: "Accepted",
    }) as MeetingSuggestion;
    setData((prev) => prev ? {
      ...prev,
      meeting_suggestions: (prev.meeting_suggestions ?? []).map((x) => x.id === s.id ? updated : x),
    } : prev);
    setEditingId(null);
  }

  // ── Apply accepted ─────────────────────────────────────────────────────────
  async function handleApplyAll() {
    setApplying(true);
    setApplyError(null);
    try {
      const toApply = suggestions.filter((s) => s.status === "Accepted");
      for (const s of toApply) {
        await saveRecord("meeting_suggestions", { ...s, status: "Applied" });
      }
      const updatedMeeting = await saveRecord("meeting_intelligence", {
        ...meeting, processing_status: "Applied",
      }) as MeetingIntelligence;

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          meeting_intelligence: (prev.meeting_intelligence ?? []).map((m) =>
            m.id === id ? updatedMeeting : m,
          ),
          meeting_suggestions: (prev.meeting_suggestions ?? []).map((s) =>
            s.meeting_id === id && s.status === "Accepted" ? { ...s, status: "Applied" } : s,
          ),
        };
      });
      setShowPreview(false);
    } catch {
      setApplyError("Failed to apply changes.");
    } finally {
      setApplying(false);
    }
  }

  const acceptedCount = suggestions.filter((s) => s.status === "Accepted").length;

  // ── Provider label ─────────────────────────────────────────────────────────
  const providerLabel = aiMeta?.enabled && aiMeta.provider !== "none"
    ? `${aiMeta.provider}${aiMeta.model ? ` · ${aiMeta.model}` : ""}`
    : null;

  return (
    <AppShell>
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">{meeting.meeting_ref}</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[meeting.processing_status]}`}>
              {meeting.processing_status}
            </span>
            <span className="text-xs text-muted-foreground">{meeting.source}</span>
          </div>
          <h2 className="mt-1 text-xl font-semibold">{meeting.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {meeting.meeting_date && <span className="mr-3">{meeting.meeting_date}</span>}
            {meeting.participants && <span>{meeting.participants}</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {meeting.processing_status !== "Applied" && (
            <Button
              onClick={() => void handleAnalyse()}
              disabled={analysing}
              className="gap-2"
            >
              {analysing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {analysing ? "Analysing…" : meeting.processing_status === "Draft" ? "Analyse" : "Re-analyse"}
            </Button>
          )}
          {acceptedCount > 0 && (
            <Button variant="outline" onClick={() => setShowPreview(true)} className="gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Apply {acceptedCount} Accepted
            </Button>
          )}
        </div>
      </div>

      {/* Pre-analysis info strip */}
      {meetingLength > 0 && !analysing && meeting.processing_status !== "Applied" && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>{meetingLength.toLocaleString()} chars</span>
          {isLong && <span>{estimatedChunks} chunks</span>}
          {isLong && <span>~{estimatedChunks} AI calls</span>}
          {providerLabel && <span>{providerLabel}</span>}
          {!aiMeta?.enabled && <span className="text-amber-600">No AI provider configured</span>}
        </div>
      )}

      {/* Error banner */}
      {analyseError && (analyseError.isRateLimit ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">
                {analyseError.message}
                {analyseError.failedChunk != null && analyseError.totalChunks != null && (
                  <span className="ml-1 font-normal">
                    (failed at chunk {analyseError.failedChunk} of {analyseError.totalChunks})
                  </span>
                )}
              </p>
              {analyseError.hint && <p className="text-amber-700">{analyseError.hint}</p>}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {analyseError.message}
        </div>
      ))}

      {/* Progress stages panel */}
      {(analysing || stages.length > 0) && (
        <div className="mt-4 rounded-lg border bg-card px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            {analysing ? "Analysing meeting…" : "Analysis complete"}
          </p>
          <div className="space-y-1.5">
            {stages.map((stage, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {stage.done
                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                  : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                }
                <span className={stage.done ? "text-foreground" : "text-primary font-medium"}>
                  {stage.label}
                </span>
              </div>
            ))}
            {analysing && stages.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting…
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Summary */}
      {meeting.ai_summary && (
        <div className="mt-4 rounded-lg border bg-primary/5 p-4">
          <p className="mb-1 text-xs font-semibold uppercase text-primary">AI Summary</p>
          <p className="text-sm">{meeting.ai_summary}</p>
        </div>
      )}

      {/* Raw notes (collapsible) */}
      {meeting.raw_input && (
        <div className="mt-4 rounded-lg border bg-card">
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
            onClick={() => setShowRaw((v) => !v)}
          >
            <span>Meeting Notes ({meetingLength.toLocaleString()} chars{isLong ? ` · ${estimatedChunks} chunks` : ""})</span>
            {showRaw ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showRaw && (
            <pre className="overflow-x-auto whitespace-pre-wrap border-t px-4 py-3 text-xs text-muted-foreground font-mono leading-relaxed">
              {meeting.raw_input}
            </pre>
          )}
        </div>
      )}

      {/* Change Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h3 className="font-semibold">Change Preview</h3>
              <button onClick={() => setShowPreview(false)}><X className="h-5 w-5 text-muted-foreground" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-5 py-4 space-y-2">
              <p className="text-xs text-muted-foreground mb-3">
                The following changes will be marked as Applied. Note: suggestions do not auto-create records — navigate to the relevant module to create or update items based on the accepted suggestions.
              </p>
              {ENTITY_ORDER.map((type) => {
                const g = previewGroups[type];
                if (!g) return null;
                const parts: string[] = [];
                if (g.create) parts.push(`${g.create} new`);
                if (g.update) parts.push(`${g.update} update`);
                if (g.close) parts.push(`${g.close} close`);
                if (g.note) parts.push(`${g.note} note`);
                return (
                  <div key={type} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span className="font-medium">{ENTITY_LABELS[type]}</span>
                    <span className="text-xs text-muted-foreground">{parts.join(", ")}</span>
                  </div>
                );
              })}
            </div>
            {applyError && <p className="mx-5 mb-2 text-xs text-destructive">{applyError}</p>}
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" onClick={() => setShowPreview(false)}>Cancel</Button>
              <Button onClick={() => void handleApplyAll()} disabled={applying} className="gap-2">
                {applying && <Loader2 className="h-4 w-4 animate-spin" />}
                Mark as Applied
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Suggestions review */}
      {pendingSuggestions.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase text-muted-foreground">
              Suggested Updates ({pendingSuggestions.length})
            </h3>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => { for (const s of pendingSuggestions) await handleAccept(s); }}
                className="gap-1 text-xs"
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                Accept All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => { for (const s of pendingSuggestions) await handleReject(s); }}
                className="gap-1 text-xs"
              >
                <XCircle className="h-3.5 w-3.5 text-destructive" />
                Reject All
              </Button>
            </div>
          </div>
          {ENTITY_ORDER.map((type) => {
            const group = groupedPending[type];
            if (!group?.length) return null;
            return (
              <div key={type} className="mb-5">
                <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{ENTITY_LABELS[type]}</h4>
                <div className="space-y-3">
                  {group.map((s) => (
                    <SuggestionCard
                      key={s.id}
                      suggestion={s}
                      editingId={editingId}
                      editTitle={editTitle}
                      editDesc={editDesc}
                      rejectNote={rejectNotes[s.id] ?? ""}
                      onAccept={() => void handleAccept(s)}
                      onReject={() => void handleReject(s)}
                      onStartEdit={() => { setEditingId(s.id); setEditTitle(s.title); setEditDesc(s.description ?? ""); }}
                      onSaveEdit={() => void handleSaveEdit(s)}
                      onCancelEdit={() => setEditingId(null)}
                      onEditTitle={setEditTitle}
                      onEditDesc={setEditDesc}
                      onRejectNote={(v) => setRejectNotes((n) => ({ ...n, [s.id]: v }))}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Applied / accepted suggestions summary */}
      {appliedSuggestions.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
            Accepted / Applied ({appliedSuggestions.length})
          </h3>
          <div className="space-y-2">
            {appliedSuggestions.map((s) => (
              <div key={s.id} className="flex items-start gap-3 rounded-md border bg-card px-3 py-2 opacity-70">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <div className="min-w-0">
                  <span className="text-xs font-medium text-muted-foreground">{ENTITY_LABELS[s.entity_type]} · </span>
                  <span className="text-sm">{s.title}</span>
                  {s.existing_record_ref && (
                    <span className="ml-2 text-xs text-muted-foreground">→ {s.existing_record_ref}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rejected summary */}
      {suggestions.filter((s) => s.status === "Rejected").length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
            Rejected ({suggestions.filter((s) => s.status === "Rejected").length})
          </h3>
          <div className="space-y-2">
            {suggestions.filter((s) => s.status === "Rejected").map((s) => (
              <div key={s.id} className="flex items-start gap-3 rounded-md border bg-card px-3 py-2 opacity-60">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive/60" />
                <div className="min-w-0">
                  <span className="text-xs font-medium text-muted-foreground">{ENTITY_LABELS[s.entity_type]} · </span>
                  <span className="text-sm line-through text-muted-foreground">{s.title}</span>
                  {s.feedback && <span className="ml-2 text-xs text-muted-foreground">({s.feedback})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state after analysis */}
      {meeting.processing_status !== "Draft" && !analysing &&
        pendingSuggestions.length === 0 && appliedSuggestions.length === 0 &&
        suggestions.filter((s) => s.status === "Rejected").length === 0 && (
        <div className="mt-8 rounded-lg border border-dashed p-8 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm">No suggestions were generated.</p>
          <p className="mt-1 text-xs text-muted-foreground">Try re-analysing with more detailed meeting notes.</p>
          <Button variant="outline" className="mt-4 gap-2" onClick={() => void handleAnalyse()} disabled={analysing}>
            <RefreshCw className="h-4 w-4" />
            Re-analyse
          </Button>
        </div>
      )}
    </AppShell>
  );
}

// ── SuggestionCard ────────────────────────────────────────────────────────────

type SuggestionCardProps = {
  suggestion: MeetingSuggestion;
  editingId: string | null;
  editTitle: string;
  editDesc: string;
  rejectNote: string;
  onAccept: () => void;
  onReject: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditTitle: (v: string) => void;
  onEditDesc: (v: string) => void;
  onRejectNote: (v: string) => void;
};

function SuggestionCard({
  suggestion: s,
  editingId,
  editTitle,
  editDesc,
  rejectNote,
  onAccept,
  onReject,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitle,
  onEditDesc,
  onRejectNote,
}: SuggestionCardProps) {
  const isEditing = editingId === s.id;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${ACTION_COLORS[s.action]}`}>
              {ACTION_LABELS[s.action]}
            </span>
            {s.existing_record_ref && (
              <span className="text-xs font-mono text-muted-foreground">→ {s.existing_record_ref}</span>
            )}
            <span className={`text-xs font-medium ${CONFIDENCE_COLORS[s.confidence]}`}>
              {s.confidence} confidence
            </span>
          </div>

          {isEditing ? (
            <div className="space-y-2">
              <Input value={editTitle} onChange={(e) => onEditTitle(e.target.value)} className="text-sm" />
              <Textarea
                value={editDesc}
                onChange={(e) => onEditDesc(e.target.value)}
                rows={3}
                placeholder="Description (optional)"
                className="text-xs"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={onSaveEdit} className="text-xs">Save & Accept</Button>
                <Button size="sm" variant="outline" onClick={onCancelEdit} className="text-xs">Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="font-medium text-sm">{s.title}</p>
              {s.description && <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>}
              {s.reason && <p className="mt-1.5 text-xs text-muted-foreground italic">{s.reason}</p>}
            </>
          )}
        </div>

        {!isEditing && (
          <div className="flex shrink-0 gap-1">
            <button onClick={onAccept} className="rounded-md p-1.5 text-green-600 hover:bg-green-50 transition-colors" title="Accept">
              <CheckCircle2 className="h-4 w-4" />
            </button>
            <button onClick={onStartEdit} className="rounded-md p-1.5 text-blue-600 hover:bg-blue-50 transition-colors" title="Edit">
              <Edit3 className="h-4 w-4" />
            </button>
            <button onClick={onReject} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10 transition-colors" title="Reject">
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {!isEditing && (
        <div className="mt-2">
          <Input
            value={rejectNote}
            onChange={(e) => onRejectNote(e.target.value)}
            placeholder="Rejection reason (optional — helps AI learn)"
            className="text-xs h-7"
          />
        </div>
      )}

      {s.data_payload && Object.keys(s.data_payload).length > 0 && !isEditing && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Suggested field values</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {Object.entries(s.data_payload).map(([k, v]) =>
              v != null ? (
                <span key={k} className="text-xs">
                  <span className="font-medium text-muted-foreground">{k}:</span>{" "}
                  <span>{String(v)}</span>
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}
