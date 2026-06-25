"use client";

import { CheckCircle2, ExternalLink, Link2Off, Loader2, RefreshCw, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

type Status = {
  configured: boolean;
  connected: boolean;
  email?: string;
  displayName?: string;
  expiresAt?: number;
};

export function MicrosoftConnectionPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function fetchStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/microsoft/status");
      const json = await res.json() as Status & { ok?: boolean };
      setStatus(json);
    } catch {
      setNotice({ ok: false, text: "Could not reach the Microsoft status endpoint." });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Check URL params for post-OAuth feedback
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setNotice({ ok: true, text: "Microsoft 365 connected successfully." });
    if (params.get("error")) setNotice({ ok: false, text: decodeURIComponent(params.get("error")!) });
    // Clean URL
    if (params.size) window.history.replaceState({}, "", window.location.pathname);
    void fetchStatus();
  }, []);

  async function disconnect() {
    if (!window.confirm("Disconnect Microsoft 365? You will need to reconnect to send query emails.")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/microsoft/disconnect", { method: "POST" });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setNotice({ ok: true, text: "Microsoft 365 disconnected." });
        await fetchStatus();
      } else {
        setNotice({ ok: false, text: "Failed to disconnect." });
      }
    } catch {
      setNotice({ ok: false, text: "An error occurred while disconnecting." });
    } finally {
      setDisconnecting(false);
    }
  }

  const tokenExpiry = status?.expiresAt
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(status.expiresAt))
    : null;

  return (
    <AppShell>
      <div className="mb-5">
        <p className="text-sm font-medium text-primary">Settings</p>
        <h2 className="mt-1 text-2xl font-semibold">Microsoft 365 Connection</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Connect your Microsoft 365 account to send project queries directly from Outlook. Replies come back to your Bluestonex mailbox.
        </p>
      </div>

      {notice && (
        <div className={`mb-5 rounded-md border p-3 text-sm ${notice.ok ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200" : "border-destructive/40 bg-destructive/5 text-destructive"}`}>
          {notice.text}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Connection status card */}
        <section className="overflow-hidden rounded-lg border bg-card shadow-operational">
          <div className="border-b bg-primary/[0.04] p-5">
            <h3 className="font-semibold">Connection Status</h3>
          </div>
          <div className="p-5">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Checking connection…
              </div>
            ) : !status?.configured ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-amber-600">
                  <Shield className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="font-semibold">Environment not configured</span>
                </div>
                <p className="text-sm text-muted-foreground">Microsoft 365 environment variables are missing. Add the following to your <code className="rounded bg-muted px-1">.env.local</code> file:</p>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`MICROSOFT_CLIENT_ID=your-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret
MICROSOFT_TENANT_ID=your-tenant-id
MICROSOFT_REDIRECT_URI=https://your-app/api/microsoft/callback
MICROSOFT_TOKEN_SECRET=your-32-char-secret`}</pre>
              </div>
            ) : status.connected ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="font-semibold">Connected</span>
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex gap-4"><dt className="min-w-24 font-semibold text-muted-foreground">Account</dt><dd>{status.displayName}</dd></div>
                  <div className="flex gap-4"><dt className="min-w-24 font-semibold text-muted-foreground">Email</dt><dd>{status.email}</dd></div>
                  {tokenExpiry && <div className="flex gap-4"><dt className="min-w-24 font-semibold text-muted-foreground">Token expires</dt><dd>{tokenExpiry}</dd></div>}
                </dl>
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button variant="outline" onClick={() => void fetchStatus()} disabled={loading}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Refresh status
                  </Button>
                  <Button variant="outline" onClick={() => void disconnect()} disabled={disconnecting}>
                    <Link2Off className="h-4 w-4" aria-hidden="true" />
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">No Microsoft 365 account is connected. Click the button below to authenticate with your Bluestonex account.</p>
                {/* Hard navigation required for OAuth redirect — cannot use Next.js Link */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/microsoft/auth"
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Connect Microsoft 365
                </a>
              </div>
            )}
          </div>
        </section>

        {/* Info card */}
        <section className="overflow-hidden rounded-lg border bg-card shadow-operational">
          <div className="border-b bg-primary/[0.04] p-5">
            <h3 className="font-semibold">How it works</h3>
          </div>
          <div className="space-y-4 p-5 text-sm text-muted-foreground">
            <p>When you connect Microsoft 365:</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>You are redirected to Microsoft to sign in with your Bluestonex account.</li>
              <li>Microsoft grants <strong className="text-foreground">Mail.Send</strong> and <strong className="text-foreground">User.Read</strong> permissions only.</li>
              <li>Tokens are stored in an encrypted server-side cookie. They are never sent to the browser.</li>
              <li>When you email queries, the email is sent from your Outlook account and saved to Sent Items.</li>
              <li>Replies go directly to your Bluestonex Outlook inbox.</li>
            </ol>
            <p className="mt-2 font-medium text-foreground">Permissions requested:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li><code className="rounded bg-muted px-1">Mail.Send</code> — send email as you</li>
              <li><code className="rounded bg-muted px-1">User.Read</code> — read your name and email address</li>
              <li><code className="rounded bg-muted px-1">offline_access</code> — refresh tokens without re-prompting</li>
            </ul>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
