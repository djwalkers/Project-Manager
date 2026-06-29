"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import type { ModuleConfig } from "@/lib/modules";
import { nextRef } from "@/lib/utils";

type RecordValue = Record<string, unknown>;

export function FormDialog({
  config,
  record,
  open,
  onClose,
  onSave,
  existingRecords,
}: {
  config: ModuleConfig;
  record: RecordValue | null;
  open: boolean;
  onClose: () => void;
  onSave: (record: RecordValue) => Promise<void> | void;
  existingRecords?: RecordValue[];
}) {
  const [form, setForm] = useState<RecordValue>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refErrors, setRefErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const isNew = !record?.id;
    const base = record ?? {};

    if (isNew && existingRecords) {
      const autoRefs: RecordValue = {};
      for (const field of config.fields) {
        if (field.refPrefix && !base[field.key]) {
          autoRefs[field.key] = nextRef(existingRecords, field.key, field.refPrefix);
        }
      }
      setForm({ ...base, ...autoRefs });
    } else {
      setForm(base);
    }

    setError(null);
    setRefErrors({});
  }, [record, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  function update(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    // Clear ref error when user edits the field
    if (refErrors[key]) setRefErrors((current) => { const next = { ...current }; delete next[key]; return next; });
  }

  function validateRef(fieldKey: string, value: string) {
    if (!existingRecords || !value) return;
    const isDuplicate = existingRecords.some(
      (r) => String(r[fieldKey] ?? "").toLowerCase() === value.toLowerCase() && r.id !== form.id,
    );
    setRefErrors((current) =>
      isDuplicate
        ? { ...current, [fieldKey]: "Reference already exists. Please choose another reference." }
        : (() => { const next = { ...current }; delete next[fieldKey]; return next; })(),
    );
  }

  const hasRefError = Object.keys(refErrors).length > 0;

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
            if (hasRefError) return;
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
              <span>{field.label}{field.required ? <span className="text-destructive" aria-hidden="true"> *</span> : null}</span>
              {field.type === "textarea" ? (
                <Textarea required={field.required} rows={field.rows} value={String(form[field.key] ?? "")} onChange={(event) => update(field.key, event.target.value)} />
              ) : field.type === "select" ? (
                <Select required={field.required} value={String(form[field.key] ?? "")} onChange={(event) => update(field.key, event.target.value)}>
                  <option value="">Select</option>
                  {field.options?.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                  value={String(form[field.key] ?? "")}
                  onChange={(event) => update(field.key, event.target.value)}
                  onInput={(event) => update(field.key, event.currentTarget.value)}
                  onBlur={field.refPrefix ? () => validateRef(field.key, String(form[field.key] ?? "")) : undefined}
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  aria-describedby={refErrors[field.key] ? `${field.key}-error` : undefined}
                  aria-invalid={Boolean(refErrors[field.key])}
                  className={refErrors[field.key] ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
              )}
              {refErrors[field.key] ? (
                <p id={`${field.key}-error`} className="text-sm font-normal text-destructive">{refErrors[field.key]}</p>
              ) : null}
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
            <Button type="submit" disabled={saving || hasRefError}>{saving ? "Saving…" : `Save ${config.singular}`}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
