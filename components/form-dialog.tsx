"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import type { ModuleConfig } from "@/lib/modules";

type RecordValue = Record<string, unknown>;

export function FormDialog({
  config,
  record,
  open,
  onClose,
  onSave,
}: {
  config: ModuleConfig;
  record: RecordValue | null;
  open: boolean;
  onClose: () => void;
  onSave: (record: RecordValue) => Promise<void> | void;
}) {
  const [form, setForm] = useState<RecordValue>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(record ?? {});
    setError(null);
  }, [record, open]);

  if (!open) return null;

  function update(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35">
      <div className="h-full w-full max-w-xl overflow-y-auto border-l bg-background shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-5 py-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{record?.id ? "Edit" : "Add"}</p>
            <h2 className="text-lg font-semibold">{config.singular}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close form">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <form
          className="space-y-4 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            setError(null);
            try {
              await onSave(form);
            } catch (saveError) {
              setError(saveError instanceof Error ? saveError.message : `Failed to save ${config.singular.toLowerCase()}`);
            } finally {
              setSaving(false);
            }
          }}
        >
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">
              {error}
            </div>
          ) : null}
          {config.fields.map((field) => (
            <label key={field.key} className="block space-y-2 text-sm font-medium">
              <span>{field.label}</span>
              {field.type === "textarea" ? (
                <Textarea value={String(form[field.key] ?? "")} onChange={(event) => update(field.key, event.target.value)} />
              ) : field.type === "select" ? (
                <Select value={String(form[field.key] ?? "")} onChange={(event) => update(field.key, event.target.value)}>
                  <option value="">Select</option>
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={field.type === "date" ? "date" : "text"}
                  value={String(form[field.key] ?? "")}
                  onChange={(event) => update(field.key, event.target.value)}
                />
              )}
            </label>
          ))}
          {config.key === "documents" ? (
            <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
              Document upload will be added in v2.
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : `Save ${config.singular}`}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
