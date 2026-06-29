"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { saveRecord } from "@/lib/supabase/data-store";
import { toDateInputValue } from "@/lib/utils";
import type { RequirementSignOff, SignOffStatus, SignOffType } from "@/lib/types";

const SIGN_OFF_TYPES: SignOffType[] = ["Business", "Technical", "Testing", "Customer"];
const STATUS_OPTIONS: SignOffStatus[] = ["Pending", "Approved", "Rejected"];

function statusBadge(status: SignOffStatus) {
  switch (status) {
    case "Approved": return "border-green-200 bg-green-50 text-green-700";
    case "Rejected": return "border-red-200 bg-red-50 text-red-700";
    default:         return "border-amber-200 bg-amber-50 text-amber-700";
  }
}

function statusIcon(status: SignOffStatus) {
  if (status === "Approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
  if (status === "Rejected") return <XCircle className="h-3.5 w-3.5 text-red-600" />;
  return <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-400" />;
}

type SignOffRow = {
  type: SignOffType;
  record: RequirementSignOff | null;
};

type EditForm = { person: string; sign_off_date: string; status: SignOffStatus; notes: string };
const emptyForm = (status: SignOffStatus = "Pending"): EditForm => ({ person: "", sign_off_date: "", status, notes: "" });

export function RequirementSignOffPanel({
  requirementId,
  projectId,
  signOffs,
  onUpdate,
}: {
  requirementId: string;
  projectId: string;
  signOffs: RequirementSignOff[];
  onUpdate: (updated: RequirementSignOff[]) => void;
}) {
  const [editType, setEditType] = useState<SignOffType | null>(null);
  const [form, setForm] = useState<EditForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows: SignOffRow[] = SIGN_OFF_TYPES.map((type) => ({
    type,
    record: signOffs.find((s) => s.sign_off_type === type) ?? null,
  }));

  function startEdit(row: SignOffRow) {
    const r = row.record;
    setForm(r ? {
      person: r.person ?? "",
      sign_off_date: toDateInputValue(r.sign_off_date),
      status: r.status,
      notes: r.notes ?? "",
    } : emptyForm());
    setEditType(row.type);
    setError(null);
  }

  function cancel() {
    setEditType(null);
    setError(null);
  }

  async function save() {
    if (!editType) return;
    setSaving(true);
    setError(null);
    try {
      const existing = signOffs.find((s) => s.sign_off_type === editType);
      const payload = {
        project_id: projectId,
        requirement_id: requirementId,
        sign_off_type: editType,
        person: form.person || null,
        sign_off_date: form.sign_off_date || null,
        status: form.status,
        notes: form.notes || null,
      };
      const saved = await saveRecord("requirement_sign_offs", existing ? { ...existing, ...payload } : payload) as RequirementSignOff;
      if (existing) {
        onUpdate(signOffs.map((s) => s.id === saved.id ? saved : s));
      } else {
        onUpdate([...signOffs, saved]);
      }
      cancel();
    } catch {
      setError("Failed to save — check Supabase connection.");
    } finally {
      setSaving(false);
    }
  }

  const approvedCount = rows.filter((r) => r.record?.status === "Approved").length;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Sign-off</p>
        <span className="text-xs text-muted-foreground tabular-nums">{approvedCount} / {SIGN_OFF_TYPES.length} Approved</span>
      </div>

      {error && <p className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.type}>
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${editType === row.type ? "border-primary/40 bg-primary/5" : "bg-muted/20"}`}
              onClick={() => editType === row.type ? cancel() : startEdit(row)}
            >
              {statusIcon(row.record?.status ?? "Pending")}
              <span className="text-sm font-medium w-20 shrink-0">{row.type}</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge(row.record?.status ?? "Pending")}`}>
                {row.record?.status ?? "Pending"}
              </span>
              {row.record?.person && <span className="text-xs text-muted-foreground truncate">{row.record.person}</span>}
              {row.record?.sign_off_date && <span className="text-xs text-muted-foreground ml-auto shrink-0">{toDateInputValue(row.record.sign_off_date)}</span>}
            </div>

            {editType === row.type && (
              <div className="mx-1 rounded-b-md border border-t-0 bg-card px-3 pb-3 pt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Status</label>
                    <Select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as SignOffStatus }))}>
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Person</label>
                    <Input value={form.person} onChange={(e) => setForm((p) => ({ ...p, person: e.target.value }))} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Date</label>
                    <Input type="date" value={form.sign_off_date} onChange={(e) => setForm((p) => ({ ...p, sign_off_date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Notes</label>
                    <Textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={1} />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={cancel}>Cancel</Button>
                  <Button size="sm" onClick={() => void save()} disabled={saving}>
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
