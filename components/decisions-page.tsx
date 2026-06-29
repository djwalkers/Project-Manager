"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { loadSelectedProjectId } from "@/lib/project-selection";
import { selectProjectById } from "@/lib/project-scope";
import { moduleByKey } from "@/lib/modules";
import { saveRecord } from "@/lib/supabase/data-store";
import type { ActionItem, Decision, Requirement } from "@/lib/types";
import { nextRef } from "@/lib/utils";
import { useProjectData } from "@/lib/use-project-data";

type Row = Record<string, unknown>;

export function DecisionsPage() {
  const { data, setData, error, reload } = useProjectData();
  const { user } = useAuth();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [createReqFrom, setCreateReqFrom] = useState<Decision | null>(null);
  const [createActionFrom, setCreateActionFrom] = useState<Decision | null>(null);

  const config = moduleByKey.get("decisions")!;
  const reqConfig = moduleByKey.get("requirements")!;
  const actionConfig = moduleByKey.get("actions")!;
  const activeProject = data ? selectProjectById(data, selectedProjectId) : null;

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  const defaultValues = useMemo(
    () => (user?.fullName ? { owner: user.fullName } : undefined),
    [user],
  );

  async function persistRecord(record: Row) {
    const saved = await saveRecord("decisions", {
      ...record,
      project_id: record.project_id ?? activeProject?.id,
    });
    setData((current) => {
      if (!current) return current;
      const rows = current.decisions as Decision[];
      const savedD = saved as Decision;
      const exists = rows.some((r) => r.id === savedD.id);
      return {
        ...current,
        decisions: exists ? rows.map((r) => (r.id === savedD.id ? savedD : r)) : [savedD, ...rows],
      };
    });
    return saved as Row;
  }

  async function removeRecord(record: Row) {
    const { deleteRecord } = await import("@/lib/supabase/data-store");
    if (!record.id) throw new Error("Cannot delete a record without an ID");
    await deleteRecord("decisions", String(record.id));
    setData((current) =>
      current ? { ...current, decisions: current.decisions.filter((r) => r.id !== record.id) } : current,
    );
  }

  async function saveRequirement(record: Row) {
    const saved = await saveRecord("requirements", {
      ...record,
      project_id: activeProject?.id,
    });
    setData((current) => {
      if (!current) return current;
      const savedR = saved as Requirement;
      return { ...current, requirements: [savedR, ...current.requirements] };
    });
    setCreateReqFrom(null);
    return saved as Row;
  }

  async function saveAction(record: Row) {
    const saved = await saveRecord("actions", {
      ...record,
      project_id: activeProject?.id,
    });
    setData((current) => {
      if (!current) return current;
      const savedA = saved as ActionItem;
      return { ...current, actions: [savedA, ...current.actions] };
    });
    setCreateActionFrom(null);
    return saved as Row;
  }

  function detailFooter(row: Row) {
    const d = row as unknown as Decision;
    if (d.status !== "Approved") return null;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Create from Decision</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreateReqFrom(d)}
        >
          Create Requirement
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreateActionFrom(d)}
        >
          Create Action
        </Button>
      </div>
    );
  }

  const reqDefaultsFromDecision = useMemo((): Row | undefined => {
    if (!createReqFrom || !data) return undefined;
    return {
      requirement_ref: nextRef(data.requirements as unknown as Row[], "requirement_ref", "REQ"),
      title: createReqFrom.question ?? "",
      description: createReqFrom.decision ?? "",
      status: "Open",
      owner: createReqFrom.owner ?? user?.fullName ?? "",
    };
  }, [createReqFrom, data, user]);

  const actionDefaultsFromDecision = useMemo((): Row | undefined => {
    if (!createActionFrom || !data) return undefined;
    return {
      action_ref: nextRef(data.actions as unknown as Row[], "action_ref", "ACT"),
      description: createActionFrom.question ?? "",
      owner: createActionFrom.owner ?? user?.fullName ?? "",
      status: "Open",
    };
  }, [createActionFrom, data, user]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">{activeProject?.name ?? "Project"}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">{config.title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{config.description}</p>
        </div>
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {data.decisions.length} total records
        </p>
      </div>

      <DataTable
        config={config}
        data={data}
        onSaveRecord={persistRecord}
        onDeleteRecord={removeRecord}
        defaultValues={defaultValues}
        detailFooter={detailFooter}
      />

      {createReqFrom && data && (
        <FormDialog
          config={reqConfig}
          record={reqDefaultsFromDecision ?? {}}
          open={true}
          onClose={() => setCreateReqFrom(null)}
          onSave={(record) => void saveRequirement(record as Row)}
          existingRecords={data.requirements as unknown as Row[]}
        />
      )}

      {createActionFrom && data && (
        <FormDialog
          config={actionConfig}
          record={actionDefaultsFromDecision ?? {}}
          open={true}
          onClose={() => setCreateActionFrom(null)}
          onSave={(record) => void saveAction(record as Row)}
          existingRecords={data.actions as unknown as Row[]}
        />
      )}
    </AppShell>
  );
}
