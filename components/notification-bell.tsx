"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, X } from "lucide-react";
import { buildRecommendations } from "@/lib/recommendations";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

const DISMISSED_KEY = "notification_dismissed_ids";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

export function NotificationBell() {
  const { data } = useProjectData();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load dismissed ids on mount
  useEffect(() => {
    setDismissed(loadDismissed());
    setHydrated(true);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const notifications = data ? buildRecommendations(data, 10) : [];
  const visible = hydrated ? notifications.filter((n) => !dismissed.has(n.id)) : notifications;
  const count = visible.length;

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  }

  function dismissAll() {
    const next = new Set([...dismissed, ...visible.map((n) => n.id)]);
    setDismissed(next);
    saveDismissed(next);
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        aria-label={count > 0 ? `${count} notifications` : "No notifications"}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open && "bg-muted text-foreground",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {count > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border bg-card shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {visible.length > 0 && (
              <button
                type="button"
                onClick={dismissAll}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Dismiss all
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-[min(60vh,400px)] overflow-y-auto">
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                <p className="text-sm font-medium">All clear</p>
                <p className="text-xs text-muted-foreground">No active notifications.</p>
              </div>
            ) : (
              <ul className="divide-y">
                {visible.map((n) => {
                  const urgencyBorder = {
                    critical: "border-l-red-500",
                    high: "border-l-amber-500",
                    medium: "border-l-blue-400",
                    low: "border-l-muted-foreground/30",
                  }[n.urgency];
                  return (
                    <li key={n.id} className={cn("flex items-start gap-3 border-l-2 px-4 py-3", urgencyBorder)}>
                      <Link href={n.href} className="min-w-0 flex-1" onClick={() => setOpen(false)}>
                        <p className="text-sm font-medium leading-snug hover:text-primary">{n.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.reason}</p>
                      </Link>
                      <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() => dismiss(n.id)}
                        className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="border-t px-4 py-2">
            <Link
              href="/"
              className="text-xs text-primary hover:underline"
              onClick={() => setOpen(false)}
            >
              View workbench →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
