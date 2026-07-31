import { cn } from "@/lib/utils";

// ── Skeleton primitives ───────────────────────────────────────────────────────

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <Bone className="h-4 w-1/3 mb-3" />
      <Bone className="h-3 w-full mb-2" />
      <Bone className="h-3 w-2/3" />
    </div>
  );
}

export function SkeletonKpiGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4 shadow-sm">
          <Bone className="h-3 w-1/2 mb-3" />
          <Bone className="h-8 w-1/3 mb-2" />
          <Bone className="h-2 w-full" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="border-b p-4">
        <Bone className="h-9 w-full max-w-sm" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Bone className="h-4 w-16 shrink-0" />
            <Bone className="h-4 flex-1" />
            <Bone className="h-6 w-20 shrink-0" />
            <Bone className="h-6 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonWorkbench() {
  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <Bone className="h-4 w-28 mb-2" />
        <Bone className="h-8 w-64 mb-2" />
        <Bone className="h-3 w-48" />
      </div>
      {/* Stat bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-4">
            <Bone className="h-7 w-10 mb-2" />
            <Bone className="h-3 w-full" />
          </div>
        ))}
      </div>
      {/* Content */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="space-y-5">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </div>
  );
}

export function SkeletonReport() {
  return (
    <div className="rounded-lg border bg-card p-8 shadow-sm space-y-6">
      <div className="border-b pb-4">
        <Bone className="h-7 w-1/2 mb-2" />
        <Bone className="h-3 w-1/3" />
      </div>
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-4 text-center">
            <Bone className="h-8 w-12 mx-auto mb-2" />
            <Bone className="h-3 w-full" />
          </div>
        ))}
      </div>
      <Bone className="h-4 w-1/4 mb-2" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Bone key={i} className="h-3 w-full" />
      ))}
    </div>
  );
}

// ── Full-page loading wrappers ─────────────────────────────────────────────────

export function LoadingState({ variant = "card" }: { variant?: "card" | "workbench" | "table" | "report" }) {
  if (variant === "workbench") return <SkeletonWorkbench />;
  if (variant === "table") return <SkeletonTable />;
  if (variant === "report") return <SkeletonReport />;
  return (
    <div className="space-y-4">
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────────

export function LoadErrorState({
  onRetry,
  detail,
}: {
  onRetry: () => void;
  detail?: string | null;
}) {
  // Log the raw detail to console only — never render raw errors to users
  if (detail && typeof console !== "undefined") {
    console.error("[LoadErrorState]", detail);
  }

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center shadow-sm">
      <p className="font-semibold text-destructive">Unable to load project data</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong while loading this page. This is usually a configuration
        or connectivity issue.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Check the browser console for technical details.
      </p>
      <button
        className="mt-4 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  );
}
