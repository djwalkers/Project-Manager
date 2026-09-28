"use client";

import { Cpu, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { canConfigureSystem } from "@/lib/permissions";

// System Health → Local extraction worker (Phase 1B). Shows whether the
// worker is configured and recently seen, and the extraction queue. Admin
// can issue (rotate) the worker token; it is displayed exactly once.

type WorkerStatus = {
  configured: boolean;
  name: string | null;
  last_seen_at: string | null;
  last_seen_version: string | null;
  online: boolean;
  queue: { queued: number; running: number; failed_24h: number; completed_24h: number };
};

const when = (value: string | null) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never";

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "bad" | "warn" }) {
  const color = tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-700 dark:text-amber-300" : "";
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export function ExtractionWorkerHealth() {
  const { user } = useAuth();
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const isAdmin = canConfigureSystem(user?.role);

  const load = () => fetch("/api/worker/status", { credentials: "same-origin" })
    .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body?.error ?? "Unavailable"); setStatus(body); })
    .catch((e) => setError(e instanceof Error ? e.message : "Unavailable"));
  useEffect(() => { void load(); }, []);

  async function issue() {
    if (status?.configured && !window.confirm("Issue a new worker token? The current token stops working immediately.")) return;
    setIssuing(true);
    setError(null);
    try {
      const r = await fetch("/api/worker/credentials", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? "Could not issue a token");
      setToken(body.token);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not issue a token");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="extraction-worker-title">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Cpu className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <h3 id="extraction-worker-title" className="font-semibold">Local extraction worker</h3>
            <p className="mt-1 text-sm text-muted-foreground">Deterministic PDF/DOCX text extraction runs on your Mac (local-worker/), never on Vercel or an AI service.</p>
          </div>
        </div>
        {isAdmin ? (
          <Button variant="outline" size="sm" onClick={issue} disabled={issuing}><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />{status?.configured ? "Rotate worker token" : "Issue worker token"}</Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
      {token ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-semibold">Copy this token into local-worker/config.json now — it will not be shown again.</p>
          <code className="mt-2 block break-all rounded bg-background px-2 py-1 font-mono text-xs text-foreground">{token}</code>
        </div>
      ) : null}
      {status ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Worker" value={!status.configured ? "Not configured" : status.online ? "Online" : "Offline"} tone={!status.configured ? "warn" : status.online ? "ok" : "bad"} />
          <Tile label="Last seen" value={when(status.last_seen_at)} />
          <Tile label="Worker version" value={status.last_seen_version ?? "—"} />
          <Tile label="Queued" value={status.queue.queued} tone={status.queue.queued && !status.online ? "warn" : undefined} />
          <Tile label="Running" value={status.queue.running} />
          <Tile label="Failed (24h)" value={status.queue.failed_24h} tone={status.queue.failed_24h ? "bad" : undefined} />
        </div>
      ) : null}
    </section>
  );
}
