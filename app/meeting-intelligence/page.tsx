"use client";

import {
  Calendar,
  CheckCircle2,
  Clock,
  Loader2,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { saveRecord } from "@/lib/supabase/data-store";
import { useProjectData } from "@/lib/use-project-data";
import { selectActiveProject } from "@/lib/project-scope";
import { nextRef } from "@/lib/utils";
import type { MeetingIntelligence, MeetingSource, MeetingStatus } from "@/lib/types";

const STATUS_COLORS: Record<MeetingStatus, string> = {
  Draft:    "border-slate-200 bg-slate-50 text-slate-700",
  Analysed: "border-amber-200 bg-amber-50 text-amber-700",
  Applied:  "border-green-200 bg-green-50 text-green-700",
  Archived: "border-muted bg-muted/40 text-muted-foreground",
};

const SOURCE_OPTIONS: MeetingSource[] = ["Teams", "Zoom", "Email", "Workshop", "Document", "Other"];

type NewForm = {
  title: string;
  meeting_date: string;
  source: MeetingSource;
  participants: string;
  raw_input: string;
};

const emptyForm = (): NewForm => ({
  title: "",
  meeting_date: new Date().toISOString().slice(0, 10),
  source: "Teams",
  participants: "",
  raw_input: "",
});

export default function MeetingIntelligencePage() {
  const { data, setData, error, reload } = useProjectData();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  const project = selectActiveProject(data);
  const meetings: MeetingIntelligence[] = (data.meeting_intelligence ?? [])
    .filter((m) => !project || m.project_id === project.id)
    .sort((a, b) => (b.meeting_date ?? "").localeCompare(a.meeting_date ?? ""));

  const pending = meetings.filter((m) => m.processing_status === "Analysed").length;
  const applied = meetings.filter((m) => m.processing_status === "Applied").length;

  function updateForm(k: keyof NewForm, v: string) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleCreate() {
    if (!form.title.trim()) { setFormError("Title is required."); return; }
    if (!project) { setFormError("No active project."); return; }
    if (!data) { setFormError("Data not loaded."); return; }
    setSaving(true);
    setFormError(null);
    try {
      const allMeetings = (data.meeting_intelligence ?? []) as Array<Record<string, unknown>>;
      const ref = nextRef(allMeetings, "meeting_ref", "MTG");
      const saved = await saveRecord("meeting_intelligence", {
        project_id: project.id,
        meeting_ref: ref,
        title: form.title,
        meeting_date: form.meeting_date || null,
        source: form.source,
        participants: form.participants || null,
        raw_input: form.raw_input || null,
        ai_summary: null,
        processing_status: "Draft",
      }) as MeetingIntelligence;
      setData((prev) => prev
        ? { ...prev, meeting_intelligence: [...(prev.meeting_intelligence ?? []), saved] }
        : prev,
      );
      setShowForm(false);
      setForm(emptyForm());
    } catch {
      setFormError("Failed to save — check Supabase connection.");
    } finally {
      setSaving(false);
    }
  }

  // Stats for the sidebar summary
  const pendingSuggestions = (data.meeting_suggestions ?? []).filter(
    (s) => s.status === "Pending" && (!project || s.project_id === project.id),
  ).length;

  return (
    <AppShell>
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p className="text-sm font-medium text-primary">AI-Assisted Processing</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">Meeting Intelligence</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Paste AI meeting notes — receive structured suggestions for project updates.
          </p>
        </div>
        <Button onClick={() => setShowForm(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          New Meeting
        </Button>
      </div>

      {/* Stats strip */}
      <div className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Total</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{meetings.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Pending Review</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${pending ? "text-amber-600" : ""}`}>{pending}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Applied</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-green-700">{applied}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Suggestions Pending</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${pendingSuggestions ? "text-amber-600" : ""}`}>{pendingSuggestions}</p>
        </div>
      </div>

      {/* New Meeting Form */}
      {showForm && (
        <div className="mt-5 rounded-lg border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-base font-semibold">New Meeting</h3>
          {formError && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{formError}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium">Title <span className="text-destructive">*</span></label>
              <Input value={form.title} onChange={(e) => updateForm("title", e.target.value)} placeholder="e.g. Replenishment Kick-off" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Meeting Date</label>
              <Input type="date" value={form.meeting_date} onChange={(e) => updateForm("meeting_date", e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Source</label>
              <Select value={form.source} onChange={(e) => updateForm("source", e.target.value as MeetingSource)}>
                {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Participants</label>
              <Input value={form.participants} onChange={(e) => updateForm("participants", e.target.value)} placeholder="Comma-separated names" />
            </div>
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium">Meeting Notes / AI Summary</label>
            <Textarea
              value={form.raw_input}
              onChange={(e) => updateForm("raw_input", e.target.value)}
              rows={8}
              placeholder="Paste Teams AI meeting notes, workshop notes, or any meeting summary here…"
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setShowForm(false); setForm(emptyForm()); }}>Cancel</Button>
            <Button onClick={() => void handleCreate()} disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Meeting
            </Button>
          </div>
        </div>
      )}

      {/* Meeting Timeline — Part 8 */}
      <div className="mt-6">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase text-muted-foreground">
          <Calendar className="h-4 w-4" />
          Meeting Timeline
        </h3>
        {meetings.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium">No meetings yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create your first meeting to start using AI analysis.
            </p>
            <Button className="mt-4 gap-2" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" />
              New Meeting
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {meetings.map((m) => {
              const suggestions = (data.meeting_suggestions ?? []).filter(
                (s) => s.meeting_id === m.id,
              );
              const pending = suggestions.filter((s) => s.status === "Pending").length;
              const accepted = suggestions.filter((s) => ["Accepted", "Applied"].includes(s.status)).length;
              return (
                <Link
                  key={m.id}
                  href={`/meeting-intelligence/${m.id}`}
                  className="flex items-start gap-4 rounded-lg border bg-card p-4 transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/20"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-muted-foreground">{m.meeting_ref}</span>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[m.processing_status]}`}>
                        {m.processing_status}
                      </span>
                      <span className="text-xs text-muted-foreground">{m.source}</span>
                    </div>
                    <p className="mt-1 font-medium">{m.title}</p>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {m.meeting_date && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {m.meeting_date}
                        </span>
                      )}
                      {m.participants && (
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {m.participants}
                        </span>
                      )}
                      {suggestions.length > 0 && (
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3 text-green-600" />
                          {accepted} applied
                        </span>
                      )}
                      {pending > 0 && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <Clock className="h-3 w-3" />
                          {pending} pending review
                        </span>
                      )}
                    </div>
                    {m.ai_summary && (
                      <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">{m.ai_summary}</p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
