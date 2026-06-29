"use client";

import { ExternalLink, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { saveRecord, deleteRecord } from "@/lib/supabase/data-store";
import { toDateInputValue } from "@/lib/utils";
import type { Evidence, EvidenceType } from "@/lib/types";

const EVIDENCE_TYPE_OPTIONS: EvidenceType[] = [
  "Screenshot", "Test Result", "SQL Query", "Customer Email",
  "Meeting Note", "Design Document", "Other",
];

const TYPE_BADGE: Record<EvidenceType, string> = {
  "Screenshot":       "border-blue-200 bg-blue-50 text-blue-700",
  "Test Result":      "border-green-200 bg-green-50 text-green-700",
  "SQL Query":        "border-purple-200 bg-purple-50 text-purple-700",
  "Customer Email":   "border-amber-200 bg-amber-50 text-amber-700",
  "Meeting Note":     "border-slate-200 bg-slate-50 text-slate-700",
  "Design Document":  "border-indigo-200 bg-indigo-50 text-indigo-700",
  "Other":            "border-border bg-muted/40 text-muted-foreground",
};

type EvidenceForm = {
  evidence_type: EvidenceType;
  title: string;
  description: string;
  url: string;
  evidence_date: string;
  owner: string;
};

const emptyForm = (): EvidenceForm => ({
  evidence_type: "Other",
  title: "",
  description: "",
  url: "",
  evidence_date: "",
  owner: "",
});

export function EvidencePanel({
  acId,
  projectId,
  evidence,
  onUpdate,
}: {
  acId: string;
  projectId: string;
  evidence: Evidence[];
  onUpdate: (updated: Evidence[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<EvidenceForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof EvidenceForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function startAdd() {
    setForm(emptyForm());
    setEditId(null);
    setAdding(true);
    setError(null);
  }

  function startEdit(ev: Evidence) {
    setForm({
      evidence_type: ev.evidence_type,
      title: ev.title,
      description: ev.description ?? "",
      url: ev.url ?? "",
      evidence_date: toDateInputValue(ev.evidence_date),
      owner: ev.owner ?? "",
    });
    setEditId(ev.id);
    setAdding(false);
    setError(null);
  }

  function cancel() {
    setAdding(false);
    setEditId(null);
    setError(null);
  }

  async function save() {
    if (!form.title.trim()) { setError("Title is required."); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        project_id: projectId,
        ac_id: acId,
        evidence_type: form.evidence_type,
        title: form.title,
        description: form.description || null,
        url: form.url || null,
        evidence_date: form.evidence_date || null,
        owner: form.owner || null,
      };
      if (adding) {
        const saved = await saveRecord("evidence", payload) as Evidence;
        onUpdate([...evidence, saved]);
      } else if (editId) {
        const existing = evidence.find((e) => e.id === editId);
        if (!existing) return;
        const saved = await saveRecord("evidence", { ...existing, ...payload }) as Evidence;
        onUpdate(evidence.map((e) => e.id === editId ? saved : e));
      }
      cancel();
    } catch {
      setError("Failed to save — check Supabase connection.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteRecord("evidence", id);
      onUpdate(evidence.filter((e) => e.id !== id));
    } catch {
      setError("Failed to delete evidence.");
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {/* Inline form */}
      {(adding || editId) && (
        <div className="rounded-md border bg-card p-3 space-y-2">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{adding ? "Add Evidence" : "Edit Evidence"}</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium mb-1">Type</label>
              <Select value={form.evidence_type} onChange={(e) => update("evidence_type", e.target.value as EvidenceType)}>
                {EVIDENCE_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Owner</label>
              <Input value={form.owner} onChange={(e) => update("owner", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Title <span className="text-destructive">*</span></label>
            <Input value={form.title} onChange={(e) => update("title", e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <Textarea value={form.description} onChange={(e) => update("description", e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium mb-1">URL / Reference</label>
              <Input value={form.url} onChange={(e) => update("url", e.target.value)} placeholder="https://..." />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Evidence Date</label>
              <Input type="date" value={form.evidence_date} onChange={(e) => update("evidence_date", e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={cancel}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              Save
            </Button>
          </div>
        </div>
      )}

      {/* Evidence list */}
      {evidence.map((ev) => (
        <div key={ev.id} className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <FileText className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[ev.evidence_type] ?? TYPE_BADGE["Other"]}`}>{ev.evidence_type}</span>
              <span className="text-xs font-semibold">{ev.title}</span>
              {ev.owner && <span className="text-xs text-muted-foreground">{ev.owner}</span>}
              {ev.evidence_date && <span className="text-xs text-muted-foreground">{toDateInputValue(ev.evidence_date)}</span>}
            </div>
            {ev.description && <p className="mt-0.5 text-xs text-muted-foreground">{ev.description}</p>}
            {ev.url && (
              <a href={ev.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="h-3 w-3" />{ev.url.length > 50 ? ev.url.slice(0, 50) + "…" : ev.url}
              </a>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={() => startEdit(ev)} className="rounded p-1 text-muted-foreground hover:text-foreground">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button type="button" onClick={() => void remove(ev.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      ))}

      {!adding && !editId && (
        <button
          type="button"
          onClick={startAdd}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
        >
          <Plus className="h-3 w-3" />
          Add evidence
        </button>
      )}
    </div>
  );
}
