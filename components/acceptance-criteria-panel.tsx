"use client";

import { CheckCircle2, Circle, Clock, Loader2, Plus, Shield, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { saveRecord, deleteRecord } from "@/lib/supabase/data-store";
import type { AcceptanceCriteria, AcceptanceCriteriaStatus } from "@/lib/types";
import { nextRef } from "@/lib/utils";

type Row = Record<string, unknown>;

const AC_STATUS_OPTIONS: AcceptanceCriteriaStatus[] = ["Not Started", "In Progress", "Met", "Failed", "Waived"];

function statusIcon(status: AcceptanceCriteriaStatus) {
  switch (status) {
    case "Met":        return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="Met" />;
    case "Failed":     return <XCircle      className="h-4 w-4 shrink-0 text-red-600"   aria-label="Failed" />;
    case "In Progress":return <Clock        className="h-4 w-4 shrink-0 text-amber-500" aria-label="In Progress" />;
    case "Waived":     return <Shield       className="h-4 w-4 shrink-0 text-blue-500"  aria-label="Waived" />;
    default:           return <Circle       className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Not Started" />;
  }
}

function statusBadgeClass(status: AcceptanceCriteriaStatus): string {
  switch (status) {
    case "Met":         return "border-green-200 bg-green-50 text-green-700";
    case "Failed":      return "border-red-200 bg-red-50 text-red-700";
    case "In Progress": return "border-amber-200 bg-amber-50 text-amber-700";
    case "Waived":      return "border-blue-200 bg-blue-50 text-blue-700";
    default:            return "border-border bg-muted/40 text-muted-foreground";
  }
}

function ProgressBar({ criteria }: { criteria: AcceptanceCriteria[] }) {
  if (!criteria.length) return null;
  const met    = criteria.filter((ac) => ac.status === "Met").length;
  const failed = criteria.filter((ac) => ac.status === "Failed").length;
  const waived = criteria.filter((ac) => ac.status === "Waived").length;
  const effective = criteria.length - waived;
  const pct = effective > 0 ? Math.round(((met + waived) / criteria.length) * 100) : (waived === criteria.length ? 100 : 0);

  return (
    <div className="mb-4 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Acceptance Progress</p>
        <span className="text-sm font-bold tabular-nums">{met} / {criteria.length} Met · {pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${failed > 0 && met === 0 ? "bg-red-500" : pct === 100 ? "bg-green-600" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {(failed > 0 || waived > 0) && (
        <div className="mt-1.5 flex gap-3 text-xs text-muted-foreground">
          {failed > 0 && <span className="text-red-600">{failed} Failed</span>}
          {waived > 0 && <span className="text-blue-600">{waived} Waived</span>}
        </div>
      )}
    </div>
  );
}

type EditForm = { criterion: string; description: string; status: AcceptanceCriteriaStatus; owner: string; evidence: string; notes: string };

const emptyForm = (): EditForm => ({ criterion: "", description: "", status: "Not Started", owner: "", evidence: "", notes: "" });

export function AcceptanceCriteriaPanel({
  requirementId,
  projectId,
  criteria,
  allCriteria,
  onUpdate,
}: {
  requirementId: string;
  projectId: string;
  criteria: AcceptanceCriteria[];
  allCriteria: AcceptanceCriteria[];
  onUpdate: (updated: AcceptanceCriteria[]) => void;
}) {
  const [adding, setAdding]     = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [form, setForm]         = useState<EditForm>(emptyForm());
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  function updateForm(key: keyof EditForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function startAdd() {
    setForm(emptyForm());
    setEditId(null);
    setAdding(true);
    setError(null);
  }

  function startEdit(ac: AcceptanceCriteria) {
    setForm({
      criterion:   ac.criterion,
      description: ac.description ?? "",
      status:      ac.status,
      owner:       ac.owner ?? "",
      evidence:    ac.evidence ?? "",
      notes:       ac.notes ?? "",
    });
    setEditId(ac.id);
    setAdding(false);
    setError(null);
  }

  function cancel() {
    setAdding(false);
    setEditId(null);
    setError(null);
  }

  async function save() {
    if (!form.criterion.trim()) { setError("Criterion is required."); return; }
    setSaving(true);
    setError(null);
    try {
      if (adding) {
        const acRef = nextRef(allCriteria as Row[], "ac_ref", "AC");
        const saved = await saveRecord("acceptance_criteria", {
          project_id: projectId, requirement_id: requirementId, ac_ref: acRef,
          criterion: form.criterion, description: form.description || null,
          status: form.status, owner: form.owner || null,
          evidence: form.evidence || null, notes: form.notes || null,
        }) as AcceptanceCriteria;
        onUpdate([...criteria, saved]);
      } else if (editId) {
        const existing = criteria.find((ac) => ac.id === editId);
        if (!existing) return;
        const saved = await saveRecord("acceptance_criteria", {
          ...existing,
          criterion: form.criterion, description: form.description || null,
          status: form.status, owner: form.owner || null,
          evidence: form.evidence || null, notes: form.notes || null,
        }) as AcceptanceCriteria;
        onUpdate(criteria.map((ac) => ac.id === editId ? saved : ac));
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
      await deleteRecord("acceptance_criteria", id);
      onUpdate(criteria.filter((ac) => ac.id !== id));
    } catch {
      setError("Failed to delete criterion.");
    }
  }

  async function quickStatus(ac: AcceptanceCriteria, status: AcceptanceCriteriaStatus) {
    const saved = await saveRecord("acceptance_criteria", { ...ac, status }) as AcceptanceCriteria;
    onUpdate(criteria.map((c) => c.id === ac.id ? saved : c));
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Acceptance Criteria
        </p>
        {!adding && !editId && (
          <Button size="sm" variant="ghost" onClick={startAdd} className="h-7 gap-1 text-xs">
            <Plus className="h-3.5 w-3.5" />
            Add Criterion
          </Button>
        )}
      </div>

      <ProgressBar criteria={criteria} />

      {error && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {/* Inline add/edit form */}
      {(adding || editId) && (
        <div className="mb-4 rounded-md border bg-card p-4 space-y-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{adding ? "New Criterion" : "Edit Criterion"}</p>
          <div>
            <label className="block text-xs font-medium mb-1">Criterion <span className="text-destructive">*</span></label>
            <Input value={form.criterion} onChange={(e) => updateForm("criterion", e.target.value)} placeholder="Describe the acceptance criterion" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Description</label>
            <Textarea value={form.description} onChange={(e) => updateForm("description", e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Status</label>
              <Select value={form.status} onChange={(e) => updateForm("status", e.target.value as AcceptanceCriteriaStatus)}>
                {AC_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Owner</label>
              <Input value={form.owner} onChange={(e) => updateForm("owner", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Evidence</label>
            <Textarea value={form.evidence} onChange={(e) => updateForm("evidence", e.target.value)} rows={2} placeholder="Evidence that this criterion has been met" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <Textarea value={form.notes} onChange={(e) => updateForm("notes", e.target.value)} rows={2} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={cancel}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}

      {criteria.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No acceptance criteria defined yet. Add criteria to define what &ldquo;done&rdquo; means for this requirement.</p>
      )}

      <div className="space-y-2">
        {criteria.map((ac) => (
          <div key={ac.id} className={`rounded-md border p-3 ${editId === ac.id ? "border-primary/40 bg-primary/5" : "bg-muted/30"}`}>
            <div className="flex items-start gap-2">
              {statusIcon(ac.status)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-muted-foreground">{ac.ac_ref}</span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(ac.status)}`}>{ac.status}</span>
                  {ac.owner && <span className="text-xs text-muted-foreground">{ac.owner}</span>}
                </div>
                <p className="mt-1 text-sm font-medium">{ac.criterion}</p>
                {ac.description && <p className="mt-0.5 text-xs text-muted-foreground">{ac.description}</p>}
                {ac.evidence && (
                  <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium">Evidence:</span> {ac.evidence}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {ac.status !== "Met" && (
                  <button
                    type="button"
                    title="Mark Met"
                    onClick={() => void quickStatus(ac, "Met")}
                    className="rounded p-1 text-green-600 hover:bg-green-50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </button>
                )}
                {ac.status !== "Failed" && (
                  <button
                    type="button"
                    title="Mark Failed"
                    onClick={() => void quickStatus(ac, "Failed")}
                    className="rounded p-1 text-red-600 hover:bg-red-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  title="Edit"
                  onClick={() => startEdit(ac)}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => void remove(ac.id)}
                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
