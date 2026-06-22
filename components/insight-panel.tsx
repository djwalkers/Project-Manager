import { StatusBadge } from "@/components/status-badge";
import type { InsightItem } from "@/lib/control-tower";

export function InsightPanel({
  title,
  description,
  items,
  emptyMessage,
}: {
  title: string;
  description: string;
  items: InsightItem[];
  emptyMessage: string;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {items.length ? (
        <div className="mt-4 space-y-3">
          {items.map((item) => (
            <article key={item.id} className="rounded-md border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.kind}</p>
                <StatusBadge value={item.severity} />
              </div>
              <p className="mt-2 text-sm font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.meta}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
      )}
    </section>
  );
}
