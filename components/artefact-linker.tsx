"use client";

import { Link2, Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { addLink, groupLinksByEntity, loadLinksForRecord, removeLink } from "@/lib/artefact-links";
import { moduleByKey } from "@/lib/modules";
import type { ArtefactLink } from "@/lib/types";
import type { DataStore } from "@/lib/data-store";

type Row = Record<string, unknown>;

// Entity types that support linking
const LINKABLE_ENTITIES: string[] = [
  "requirements",
  "acceptance_criteria",
  "decisions",
  "discovery_questions",
  "deliverables",
  "risks",
  "actions",
  "test_cases",
];

function refKey(entity: string): string {
  const map: Record<string, string> = {
    requirements: "requirement_ref",
    acceptance_criteria: "ac_ref",
    decisions: "decision_ref",
    discovery_questions: "question_ref",
    deliverables: "deliverable_ref",
    risks: "risk_ref",
    actions: "action_ref",
    test_cases: "test_ref",
    milestones: "milestone_ref",
    dependencies: "name",
  };
  return map[entity] ?? "id";
}

function labelKey(entity: string): string {
  const map: Record<string, string> = {
    requirements: "title",
    acceptance_criteria: "criterion",
    decisions: "question",
    discovery_questions: "question",
    deliverables: "title",
    risks: "description",
    actions: "description",
    test_cases: "scenario",
    milestones: "title",
    dependencies: "name",
  };
  return map[entity] ?? "id";
}

function entityLabel(entity: string): string {
  return moduleByKey.get(entity as Parameters<typeof moduleByKey.get>[0])?.title ?? entity;
}

function resolveRecord(data: DataStore, entity: string, id: string): Row | undefined {
  const rows = (data as unknown as Record<string, Row[]>)[entity] ?? [];
  return rows.find((r) => r.id === id);
}

function RecordChip({
  entity,
  id,
  data,
  linkId,
  onRemove,
}: {
  entity: string;
  id: string;
  data: DataStore;
  linkId: string;
  onRemove: (linkId: string) => void;
}) {
  const record = resolveRecord(data, entity, id);
  const ref = record ? String(record[refKey(entity)] ?? id) : id;
  const label = record ? String(record[labelKey(entity)] ?? "") : "";
  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 text-xs">
      <span className="font-semibold text-primary">{ref}</span>
      {label && <span className="truncate max-w-[180px] text-muted-foreground">{label}</span>}
      <button
        type="button"
        aria-label={`Remove link to ${ref}`}
        onClick={() => onRemove(linkId)}
        className="ml-auto text-muted-foreground hover:text-destructive"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AddLinkModal({
  ownEntity,
  ownId,
  projectId,
  data,
  existingLinkIds: existingPartnerIds,
  onAdd,
  onClose,
}: {
  ownEntity: string;
  ownId: string;
  projectId: string;
  data: DataStore;
  existingLinkIds: Set<string>;
  onAdd: (link: ArtefactLink) => void;
  onClose: () => void;
}) {
  const candidates = LINKABLE_ENTITIES.filter((e) => e !== ownEntity);
  const [targetEntity, setTargetEntity] = useState(candidates[0] ?? "");
  const [targetId, setTargetId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => ((data as unknown as Record<string, Row[]>)[targetEntity] ?? []).filter((r) => !existingPartnerIds.has(String(r.id))),
    [data, targetEntity, existingPartnerIds],
  );

  useEffect(() => {
    setTargetId(rows[0] ? String(rows[0].id) : "");
  }, [rows]);

  async function save() {
    if (!targetId) { setError("Please select a record to link."); return; }
    setSaving(true);
    setError(null);
    const saved = await addLink({ project_id: projectId, source_entity: ownEntity, source_id: ownId, target_entity: targetEntity, target_id: targetId });
    setSaving(false);
    if (!saved) { setError("Failed to save link — check Supabase connection."); return; }
    onAdd(saved);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Add Related Item</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        {error && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 space-y-3">
          <label className="block text-xs font-semibold uppercase text-muted-foreground">
            Entity type
            <select
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={targetEntity}
              onChange={(e) => setTargetEntity(e.target.value)}
            >
              {candidates.map((e) => <option key={e} value={e}>{entityLabel(e)}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold uppercase text-muted-foreground">
            Record
            <select
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {rows.length === 0 && <option value="">No records available</option>}
              {rows.map((r) => {
                const ref = String(r[refKey(targetEntity)] ?? r.id);
                const lbl = String(r[labelKey(targetEntity)] ?? "");
                return <option key={String(r.id)} value={String(r.id)}>{ref}{lbl ? ` — ${lbl.slice(0, 50)}` : ""}</option>;
              })}
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !targetId}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Link
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ArtefactLinker({
  entity,
  recordId,
  projectId,
  data,
}: {
  entity: string;
  recordId: string;
  projectId: string;
  data: DataStore;
}) {
  const [links, setLinks] = useState<ArtefactLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadLinksForRecord(entity, recordId).then((result) => {
      if (!cancelled) { setLinks(result); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [entity, recordId]);

  const groups = useMemo(() => groupLinksByEntity(links, entity, recordId), [links, entity, recordId]);

  const existingPartnerIds = useMemo(() => new Set(links.map((l) => l.source_id === recordId ? l.target_id : l.source_id)), [links, recordId]);

  async function handleRemove(linkId: string) {
    await removeLink(linkId);
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
  }

  if (loading) return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading links…</div>;

  const hasLinks = Object.keys(groups).length > 0;

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" />
          Related Items
        </p>
        <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)} className="h-7 gap-1 text-xs">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {hasLinks ? (
        <div className="mt-2 space-y-3">
          {Object.entries(groups).map(([partnerEntity, partners]) => (
            <div key={partnerEntity}>
              <p className="text-xs font-medium text-muted-foreground">{entityLabel(partnerEntity)}</p>
              <div className="mt-1 flex flex-col gap-1">
                {partners.map(({ linkId, partnerId }) => (
                  <RecordChip
                    key={linkId}
                    entity={partnerEntity}
                    id={partnerId}
                    data={data}
                    linkId={linkId}
                    onRemove={(id) => void handleRemove(id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No related items linked yet.</p>
      )}

      {addOpen && (
        <AddLinkModal
          ownEntity={entity}
          ownId={recordId}
          projectId={projectId}
          data={data}
          existingLinkIds={existingPartnerIds}
          onAdd={(link) => setLinks((prev) => [...prev, link])}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
