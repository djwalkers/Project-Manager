"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  BookOpenCheck,
  Boxes,
  BrainCircuit,
  BriefcaseBusiness,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Flag,
  GitBranch,
  History,
  LayoutDashboard,
  ListChecks,
  Mail,
  Newspaper,
  PackageCheck,
  PanelsTopLeft,
  Pin,
  Settings,
  ShieldQuestion,
  Star,
  Stethoscope,
  TrendingUp,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_NAV_ACCESS } from "@/lib/auth";
import { cn } from "@/lib/utils";

// ── Nav data ──────────────────────────────────────────────────────────────────

type NavItem = { href: string; label: string; icon: React.ElementType };

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/project-workspace", label: "Workspace", icon: PanelsTopLeft },
      { href: "/project-intelligence", label: "Intelligence", icon: BrainCircuit },
      { href: "/project-trends", label: "Trends", icon: TrendingUp },
      { href: "/daily-brief", label: "Daily Brief", icon: Newspaper },
      { href: "/manager-summary", label: "Manager Summary", icon: ClipboardList },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    items: [
      { href: "/deliverables", label: "Deliverables", icon: PackageCheck },
      { href: "/timeline", label: "Timeline", icon: CalendarRange },
      { href: "/milestones", label: "Milestones", icon: Flag },
      { href: "/testing", label: "Testing", icon: BookOpenCheck },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    items: [
      { href: "/requirements", label: "Requirements", icon: ListChecks },
      { href: "/risks", label: "Risks", icon: AlertTriangle },
      { href: "/decisions", label: "Decisions", icon: ShieldQuestion },
      { href: "/actions", label: "Actions", icon: ClipboardCheck },
      { href: "/discovery-questions", label: "Discovery Questions", icon: CircleHelp },
      { href: "/dependencies", label: "Dependencies", icon: GitBranch },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/meetings", label: "Meetings", icon: CalendarDays },
      { href: "/documents", label: "Documents", icon: FileText },
      { href: "/audit-trail", label: "Audit Trail", icon: History },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { href: "/projects", label: "Projects", icon: BriefcaseBusiness },
      { href: "/email-settings", label: "Email Settings", icon: Mail },
      { href: "/system-health", label: "System Health", icon: Stethoscope },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

const DEFAULT_FAVOURITES = [
  "/project-workspace",
  "/",
  "/deliverables",
  "/risks",
  "/timeline",
];

const MAX_FAVOURITES = 5;

const STORAGE_COLLAPSED = "nav_collapsed_groups";
const STORAGE_FAVOURITES = "nav_favourites";

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NavLink({ item, active, pinned, onPin, compact = false }: {
  item: NavItem;
  active: boolean;
  pinned: boolean;
  onPin: (href: string) => void;
  compact?: boolean;
}) {
  const Icon = item.icon;
  return (
    <div className="group relative flex items-center">
      <Link
        href={item.href}
        className={cn(
          "flex min-h-9 flex-1 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-secondary text-secondary-foreground",
          compact && "px-2",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
      </Link>
      <button
        onClick={() => onPin(item.href)}
        aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
        className={cn(
          "absolute right-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          pinned ? "text-primary opacity-100" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Pin className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}

function NavGroupSection({ group, pathname, collapsed, onToggle, favourites, onPin, visibleHrefs }: {
  group: NavGroup;
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  favourites: string[];
  onPin: (href: string) => void;
  visibleHrefs: Set<string>;
}) {
  const visibleItems = group.items.filter((item) => visibleHrefs.has(item.href));
  if (!visibleItems.length) return null;

  const hasActive = visibleItems.some((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );

  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center justify-between px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md",
          hasActive && !collapsed && "text-primary/70",
        )}
      >
        {group.label}
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
          aria-hidden="true"
        />
      </button>

      {!collapsed && (
        <div className="mt-0.5 space-y-0.5">
          {visibleItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <NavLink
                key={item.href}
                item={item}
                active={active}
                pinned={favourites.includes(item.href)}
                onPin={onPin}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main sidebar inner ────────────────────────────────────────────────────────

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
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCollapsed(load(STORAGE_COLLAPSED, {}));
    setFavourites(load(STORAGE_FAVOURITES, DEFAULT_FAVOURITES));
    setHydrated(true);
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      save(STORAGE_COLLAPSED, next);
      return next;
    });
  }, []);

  const togglePin = useCallback((href: string) => {
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

  const pinnedItems = favourites
    .map((href) => ALL_ITEMS.find((item) => item.href === href))
    .filter((item): item is NavItem => Boolean(item) && visibleHrefs.has(item!.href));

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
            <p className="text-xs text-muted-foreground">CR028 Control Centre</p>
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

      {/* Scrollable nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-4" aria-label="Main navigation">

        {/* Quick Access */}
        {pinnedItems.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
              <Star className="h-3 w-3 text-amber-500" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Quick Access
              </span>
            </div>
            <div className="mt-0.5 space-y-0.5">
              {pinnedItems.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={active}
                    pinned
                    onPin={togglePin}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Grouped sections */}
        {NAV_GROUPS.map((group) => (
          <NavGroupSection
            key={group.id}
            group={group}
            pathname={pathname}
            collapsed={collapsed[group.id] ?? false}
            onToggle={() => toggleGroup(group.id)}
            favourites={favourites}
            onPin={togglePin}
            visibleHrefs={visibleHrefs}
          />
        ))}
      </nav>

      {/* Footer hint */}
      <div className="shrink-0 border-t px-4 py-3">
        <p className="text-xs text-muted-foreground/60">
          <Pin className="mr-1 inline h-2.5 w-2.5" aria-hidden="true" />
          Pin pages to Quick Access (up to {MAX_FAVOURITES})
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

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <div className="absolute inset-y-0 left-0 w-72 bg-card shadow-xl">
        <SidebarContent onClose={onClose} />
      </div>
    </div>
  );
}
