import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

export function WorkspaceSection({ id, title, description, icon: Icon, action, children, className }: { id: string; title: string; description?: string; icon: IconType; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-lg border bg-card shadow-operational", className)} aria-labelledby={id}>
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0"><h3 id={id} className="font-semibold">{title}</h3>{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}</div>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function WorkspaceMetric({ label, value, detail, children }: { label: string; value?: ReactNode; detail?: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/30 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2 text-xl font-semibold tabular-nums">{children ?? value ?? "—"}</div>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export function WorkspaceEmpty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

