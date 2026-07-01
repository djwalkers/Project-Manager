"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ClipboardCheck,
  LayoutDashboard,
  Loader2,
  Search,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_NAV_ACCESS } from "@/lib/auth";
import { ALL_ITEMS, type NavItem } from "@/lib/nav-data";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type PaletteItem =
  | { kind: "page"; item: NavItem }
  | { kind: "command"; label: string; description: string; icon: LucideIcon; href: string };

const COMMANDS: Array<{ label: string; description: string; icon: LucideIcon; href: string }> = [
  { label: "Create Action", description: "Open the Actions register", icon: ClipboardCheck, href: "/actions" },
  { label: "Create Requirement", description: "Open the Requirements register", icon: LayoutDashboard, href: "/requirements" },
  { label: "Analyse Meeting", description: "Review meeting intelligence", icon: Sparkles, href: "/meeting-intelligence" },
  { label: "View Dashboard", description: "Go to project dashboard", icon: LayoutDashboard, href: "/" },
];

// ── CommandPalette ─────────────────────────────────────────────────────────────

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const role = user?.role ?? "Viewer";
  const access = ROLE_NAV_ACCESS[role];

  const visibleHrefs = useMemo(
    () => new Set(ALL_ITEMS.filter((i) => access === "all" || access.includes(i.href)).map((i) => i.href)),
    [access],
  );

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const q = query.trim().toLowerCase();

  const items: PaletteItem[] = useMemo(() => {
    if (!q) {
      // Default: show commands + first 8 pages
      const pages: PaletteItem[] = ALL_ITEMS
        .filter((i) => visibleHrefs.has(i.href))
        .slice(0, 8)
        .map((item) => ({ kind: "page" as const, item }));
      const commands: PaletteItem[] = COMMANDS.map((c) => ({ kind: "command" as const, ...c }));
      return [...commands, ...pages];
    }

    const pageResults: PaletteItem[] = ALL_ITEMS
      .filter((i) => {
        if (!visibleHrefs.has(i.href)) return false;
        return (
          i.label.toLowerCase().includes(q) ||
          i.href.toLowerCase().includes(q) ||
          (i.keywords?.toLowerCase().includes(q) ?? false)
        );
      })
      .map((item) => ({ kind: "page" as const, item }));

    const commandResults: PaletteItem[] = COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    ).map((c) => ({ kind: "command" as const, ...c }));

    return [...commandResults, ...pageResults];
  }, [q, visibleHrefs]);

  // Clamp activeIndex
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(items.length - 1, 0)));
  }, [items.length]);

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(items.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = items[activeIndex];
      if (selected) {
        navigate(selected.kind === "page" ? selected.item.href : selected.href);
      }
    }
  }

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-2xl"
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search pages and commands…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {query ? (
            <button
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground sm:inline">
              ESC
            </kbd>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-2" role="listbox">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 opacity-40" />
              <p className="text-sm">No results for &quot;{query}&quot;</p>
            </div>
          ) : (
            <>
              {/* Commands section */}
              {items.some((i) => i.kind === "command") && (
                <div>
                  <div className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {q ? "Commands" : "Quick Actions"}
                  </div>
                  {items
                    .filter((i): i is Extract<PaletteItem, { kind: "command" }> => i.kind === "command")
                    .map((c) => {
                      const globalIdx = items.findIndex((x) => x === c);
                      const Icon = c.icon;
                      return (
                        <button
                          key={c.href + c.label}
                          data-active={activeIndex === globalIdx ? "true" : undefined}
                          onClick={() => navigate(c.href)}
                          onMouseEnter={() => setActiveIndex(globalIdx)}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors",
                            activeIndex === globalIdx
                              ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                          )}
                          role="option"
                          aria-selected={activeIndex === globalIdx}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                          <span className="flex-1 text-left">
                            <span className="block font-medium">{c.label}</span>
                            <span className="block text-xs text-muted-foreground">{c.description}</span>
                          </span>
                          <Zap className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
                        </button>
                      );
                    })}
                </div>
              )}

              {/* Pages section */}
              {items.some((i) => i.kind === "page") && (
                <div>
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {q ? "Pages" : "Navigation"}
                  </div>
                  {items
                    .filter((i): i is Extract<PaletteItem, { kind: "page" }> => i.kind === "page")
                    .map((p) => {
                      const globalIdx = items.findIndex((x) => x === p);
                      const Icon = p.item.icon;
                      return (
                        <button
                          key={p.item.href}
                          data-active={activeIndex === globalIdx ? "true" : undefined}
                          onClick={() => navigate(p.item.href)}
                          onMouseEnter={() => setActiveIndex(globalIdx)}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors",
                            activeIndex === globalIdx
                              ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                          )}
                          role="option"
                          aria-selected={activeIndex === globalIdx}
                        >
                          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="flex-1 text-left">{p.item.label}</span>
                          <span className="text-xs text-muted-foreground/40 font-mono">{p.item.href}</span>
                        </button>
                      );
                    })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t px-4 py-2 text-[11px] text-muted-foreground/50">
          <span className="mr-3">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>
            {" "}navigate
          </span>
          <span className="mr-3">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd>
            {" "}open
          </span>
          <span>
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">esc</kbd>
            {" "}close
          </span>
        </div>
      </div>
    </div>
  );
}
