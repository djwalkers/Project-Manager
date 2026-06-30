"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";

type AIProviderName = "none" | "openai" | "gemini" | "anthropic";

type AIMeta = {
  id: string | null;
  provider: AIProviderName;
  model: string | null;
  enabled: boolean;
  key_configured: boolean;
};

const PROVIDER_LABELS: Record<AIProviderName, string> = {
  none: "None (disabled)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
};

const PROVIDER_MODELS: Record<AIProviderName, string> = {
  none: "",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  anthropic: "claude-haiku-4-5-20251001",
};

const PROVIDER_MODEL_SUGGESTIONS: Partial<Record<AIProviderName, string[]>> = {
  gemini: ["gemini-2.0-flash", "gemini-1.5-flash-latest", "gemini-2.5-flash"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
};

const KEY_PLACEHOLDER: Record<AIProviderName, string> = {
  none: "",
  openai: "sk-…",
  gemini: "AIza…",
  anthropic: "sk-ant-…",
};

export default function AISettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Admin" || user?.role === undefined; // local dev

  const [meta, setMeta] = useState<AIMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Form state
  const [provider, setProvider] = useState<AIProviderName>("none");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState(""); // empty = don't change; sentinel value
  const [clearKey, setClearKey] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/ai-settings");
        if (res.ok) {
          const data = await res.json() as AIMeta;
          setMeta(data);
          setProvider(data.provider);
          setModel(data.model ?? "");
          setEnabled(data.enabled);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function handleProviderChange(p: AIProviderName) {
    setProvider(p);
    if (!model || Object.values(PROVIDER_MODELS).includes(model)) {
      setModel(PROVIDER_MODELS[p]);
    }
    setTestResult(null);
    setClearKey(false);
    setApiKey("");
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { provider, model: model || null, enabled };
      if (clearKey) {
        body.clear_key = true;
      } else if (apiKey.trim()) {
        body.api_key = apiKey.trim();
      }
      const res = await fetch("/api/ai-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setSaveError(err.error ?? "Save failed");
        return;
      }
      const updated = await res.json() as AIMeta;
      setMeta(updated);
      setProvider(updated.provider);
      setModel(updated.model ?? "");
      setEnabled(updated.enabled);
      setApiKey("");
      setClearKey(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai-settings/test", { method: "POST" });
      const data = await res.json() as { ok: boolean; message: string };
      setTestResult(data);
    } finally {
      setTesting(false);
    }
  }

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Admin access required</p>
            <p className="mt-1 text-sm text-muted-foreground">Only Admin users can configure AI provider settings.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div>
        <p className="text-sm font-medium text-primary">Configuration</p>
        <h2 className="mt-1 text-2xl font-semibold">AI Settings</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Configure the AI provider used by Meeting Intelligence. API keys are stored server-side and never exposed to the browser.
        </p>
      </div>

      {loading ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading settings…
        </div>
      ) : (
        <div className="mt-6 max-w-xl space-y-6">
          {/* Current status */}
          {meta && (
            <div className={`flex items-center gap-3 rounded-lg border p-4 ${
              meta.enabled && meta.key_configured
                ? "border-green-200 bg-green-50"
                : "border-amber-200 bg-amber-50"
            }`}>
              {meta.enabled && meta.key_configured ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
              ) : (
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
              )}
              <div className="text-sm">
                {meta.enabled && meta.key_configured ? (
                  <span className="font-medium text-green-800">
                    {PROVIDER_LABELS[meta.provider]} is active
                  </span>
                ) : !meta.key_configured && meta.provider !== "none" ? (
                  <span className="font-medium text-amber-800">
                    {PROVIDER_LABELS[meta.provider]} selected but no API key configured
                  </span>
                ) : (
                  <span className="font-medium text-amber-800">No AI provider configured</span>
                )}
              </div>
            </div>
          )}

          {/* Provider */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">AI Provider</label>
            <Select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as AIProviderName)}
              className="max-w-xs"
            >
              {(Object.entries(PROVIDER_LABELS) as [AIProviderName, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>

          {provider !== "none" && (
            <>
              {/* Model */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Model <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={PROVIDER_MODELS[provider]}
                  className="max-w-xs font-mono text-sm"
                  list={`model-suggestions-${provider}`}
                />
                {PROVIDER_MODEL_SUGGESTIONS[provider] && (
                  <datalist id={`model-suggestions-${provider}`}>
                    {PROVIDER_MODEL_SUGGESTIONS[provider]!.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
                <p className="mt-1 text-xs text-muted-foreground">Leave blank to use the default model.</p>
              </div>

              {/* API Key */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">API Key</label>
                {meta?.key_configured && !clearKey ? (
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground font-mono">
                      <Bot className="mr-2 h-3.5 w-3.5" />
                      Configured ✓
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setClearKey(false); setApiKey(""); }}
                      className="gap-1.5 text-xs"
                    >
                      Replace key
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setClearKey(true); setApiKey(""); }}
                      className="gap-1.5 text-xs text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear
                    </Button>
                  </div>
                ) : clearKey ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-destructive">Key will be cleared on save.</p>
                    <Button variant="outline" size="sm" className="text-xs" onClick={() => setClearKey(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={KEY_PLACEHOLDER[provider]}
                      className="max-w-xs font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Stored server-side. Never returned to the browser after saving.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Enabled toggle */}
          <div className="flex items-center gap-3">
            <button
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                enabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform ${
                  enabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
            <label className="text-sm font-medium cursor-pointer" onClick={() => setEnabled((v) => !v)}>
              {enabled ? "AI analysis enabled" : "AI analysis disabled"}
            </label>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
            <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Save Settings
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleTest()}
              disabled={testing || provider === "none"}
              className="gap-2"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
          </div>

          {/* Feedback */}
          {saveError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {saveError}
            </div>
          )}
          {saveOk && (
            <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Settings saved.
            </div>
          )}
          {testResult && (
            <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
              testResult.ok
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}>
              {testResult.ok
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              }
              {testResult.message}
            </div>
          )}

          {/* Security note */}
          <div className="rounded-lg border bg-muted/40 p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold">Security</p>
            <p>API keys are stored in the Supabase database and read only by server-side API routes. They are never included in any client response.</p>
            <p>Environment variables (OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY) are used as fallback when no database key is configured.</p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
