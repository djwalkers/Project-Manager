"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  ChevronDown,
  Clock,
  Search,
  Star,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_NAV_ACCESS } from "@/lib/auth";
import { ALL_ITEMS, NAV_GROUPS, STANDALONE_ITEMS, type NavGroup, type NavItem } from "@/lib/nav-data";
import { cn } from "@/lib/utils";

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_COLLAPSED  = "nav_collapsed_groups";
const STORAGE_FAVOURITES = "nav_favourites";
const STORAGE_RECENT     = "nav_recent_pages";
const STORAGE_SCROLL     = "nav_scroll_top";

const DEFAULT_FAVOURITES = ["/project-workspace", "/", "/deliverables", "/risks", "/timeline"];
const MAX_FAVOURITES = 5;
const MAX_RECENT = 5;

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadOrNull<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isActive(item: NavItem, pathname: string): boolean {
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}

function findActiveGroupId(pathname: string): string | null {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => isActive(item, pathname))) return group.id;
  }
  return null;
}

function getInitialCollapsed(pathname: string): Record<string, boolean> {
  const saved = loadOrNull<Record<string, boolean>>(STORAGE_COLLAPSED);
  if (saved !== null) return saved;
  // First visit — expand only the group containing the active page.
  const activeId = findActiveGroupId(pathname) ?? "operations";
  return Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.id !== activeId]));
}

// ── NavLink ───────────────────────────────────────────────────────────────────

function NavLink({
  item,
  active,
  starred,
  onStar,
}: {
  item: NavItem;
  active: boolean;
  starred: boolean;
  onStar: (href: string) => void;
}) {
  const Icon = item.icon;
  return (
    <div className="group relative flex items-center">
      <Link
        href={item.href}
        className={cn(
          "flex min-h-9 flex-1 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
      </Link>
      <button
        onClick={(e) => { e.preventDefault(); onStar(item.href); }}
        aria-label={starred ? `Remove ${item.label} from favourites` : `Add ${item.label} to favourites`}
        className={cn(
          "absolute right-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          starred
            ? "text-amber-500 opacity-100"
            : "text-muted-foreground/40 hover:text-muted-foreground",
        )}
      >
        <Star
          className={cn("h-3 w-3", starred ? "fill-amber-500 text-amber-500" : "")}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

// ── NavGroupSection ───────────────────────────────────────────────────────────

function NavGroupSection({
  group,
  pathname,
  collapsed,
  onToggle,
  favourites,
  onStar,
  visibleHrefs,
}: {
  group: NavGroup;
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  favourites: string[];
  onStar: (href: string) => void;
  visibleHrefs: Set<string>;
}) {
  const visibleItems = group.items.filter((item) => visibleHrefs.has(item.href));
  if (!visibleItems.length) return null;

  const hasActive = visibleItems.some((item) => isActive(item, pathname));

  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasActive && !collapsed
            ? "text-primary/70"
            : "text-muted-foreground/70",
        )}
      >
        {group.label}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>

      {/* Animated expand/collapse via CSS grid */}
      <div
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div className="mt-0.5 space-y-0.5 pb-1">
            {visibleItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item, pathname)}
                starred={favourites.includes(item.href)}
                onStar={onStar}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SidebarContent ────────────────────────────────────────────────────────────

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const role = user?.role ?? "Viewer";
  const access = ROLE_NAV_ACCESS[role];

  const visibleHrefs = new Set(
    ALL_ITEMS
      .filter((item) => access === "all" || access.includes(item.href))
      .map((item) => item.href),
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [favourites, setFavourites] = useState<string[]>(DEFAULT_FAVOURITES);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    setCollapsed(getInitialCollapsed(pathname));
    setFavourites(load(STORAGE_FAVOURITES, DEFAULT_FAVOURITES));
    setRecent(load(STORAGE_RECENT, []));
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll position after hydration
  useEffect(() => {
    if (!hydrated || !scrollRef.current) return;
    const saved = load<number>(STORAGE_SCROLL, 0);
    scrollRef.current.scrollTop = saved;
  }, [hydrated]);

  // Track recent pages on navigation
  useEffect(() => {
    if (!hydrated) return;
    setRecent((prev) => {
      const next = [pathname, ...prev.filter((p) => p !== pathname)].slice(0, MAX_RECENT);
      save(STORAGE_RECENT, next);
      return next;
    });
  }, [pathname, hydrated]);

  // Persist scroll position (debounced)
  const handleScroll = useCallback(() => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      if (scrollRef.current) save(STORAGE_SCROLL, scrollRef.current.scrollTop);
    }, 100);
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      save(STORAGE_COLLAPSED, next);
      return next;
    });
  }, []);

  const toggleStar = useCallback((href: string) => {
    setFavourites((prev) => {
      let next: string[];
      if (prev.includes(href)) {
        next = prev.filter((h) => h !== href);
      } else if (prev.length < MAX_FAVOURITES) {
        next = [...prev, href];
      } else {
        return prev; // at capacity
      }
      save(STORAGE_FAVOURITES, next);
      return next;
    });
  }, []);

  // Derived
  const favouriteItems = favourites
    .map((href) => ALL_ITEMS.find((i) => i.href === href))
    .filter((i): i is NavItem => Boolean(i) && visibleHrefs.has(i!.href));

  const recentItems = recent
    .filter((href) => href !== pathname)
    .map((href) => ALL_ITEMS.find((i) => i.href === href))
    .filter((i): i is NavItem => Boolean(i) && visibleHrefs.has(i!.href))
    .slice(0, MAX_RECENT);

  const searchQuery = query.trim().toLowerCase();
  const searchResults = searchQuery
    ? ALL_ITEMS.filter((item) => {
        if (!visibleHrefs.has(item.href)) return false;
        return (
          item.label.toLowerCase().includes(searchQuery) ||
          item.href.toLowerCase().includes(searchQuery) ||
          (item.keywords?.toLowerCase().includes(searchQuery) ?? false)
        );
      })
    : [];

  const visibleStandaloneItems = STANDALONE_ITEMS.filter((i) => visibleHrefs.has(i.href));

  if (!hydrated) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Project Manager</p>
            <p className="text-xs text-muted-foreground">Control Centre</p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages…"
            aria-label="Search navigation"
            className="h-8 w-full rounded-md border bg-muted/40 pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {query && (
            <button
              onClick={() => { setQuery(""); searchRef.current?.focus(); }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground focus-visible:outline-none"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable nav area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3"
        style={{ scrollbarWidth: "thin" }}
      >
        <nav className="space-y-4" aria-label="Main navigation">

          {searchQuery ? (
            /* ── Search results ── */
            <div>
              <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {searchResults.length > 0
                  ? `${searchResults.length} result${searchResults.length !== 1 ? "s" : ""}`
                  : "No results"}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {searchResults.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item, pathname)}
                    starred={favourites.includes(item.href)}
                    onStar={toggleStar}
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* ── Favourites ── */}
              {favouriteItems.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" aria-hidden="true" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Favourites
                    </span>
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {favouriteItems.map((item) => (
                      <NavLink
                        key={item.href}
                        item={item}
                        active={isActive(item, pathname)}
                        starred
                        onStar={toggleStar}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* ── Recent pages ── */}
              {recentItems.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                    <Clock className="h-3 w-3 text-muted-foreground/60" aria-hidden="true" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Recent
                    </span>
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {recentItems.map((item) => (
                      <NavLink
                        key={item.href}
                        item={item}
                        active={false}
                        starred={favourites.includes(item.href)}
                        onStar={toggleStar}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* ── Standalone items (Dashboard, Workspace, Projects) ── */}
              {visibleStandaloneItems.length > 0 && (
                <div className="space-y-0.5">
                  {visibleStandaloneItems.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item, pathname)}
                      starred={favourites.includes(item.href)}
                      onStar={toggleStar}
                    />
                  ))}
                </div>
              )}

              {/* ── Collapsible groups ── */}
              {NAV_GROUPS.map((group) => (
                <NavGroupSection
                  key={group.id}
                  group={group}
                  pathname={pathname}
                  collapsed={collapsed[group.id] ?? false}
                  onToggle={() => toggleGroup(group.id)}
                  favourites={favourites}
                  onStar={toggleStar}
                  visibleHrefs={visibleHrefs}
                />
              ))}
            </>
          )}
        </nav>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t px-4 py-2.5">
        <p className="text-xs text-muted-foreground/50">
          <Star className="mr-1 inline h-2.5 w-2.5 fill-amber-400 text-amber-400" aria-hidden="true" />
          Star any page to add it to Favourites
        </p>
      </div>
    </div>
  );
}

// ── Desktop sidebar ───────────────────────────────────────────────────────────

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-hidden border-r bg-card lg:flex lg:flex-col">
      <SidebarContent />
    </aside>
  );
}

// ── Mobile drawer ─────────────────────────────────────────────────────────────

export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-y-0 left-0 w-72 bg-card shadow-xl">
        <SidebarContent onClose={onClose} />
      </div>
    </div>
  );
}
