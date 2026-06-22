import type { ComponentType, SVGProps } from "react";
import { Button } from "@/components/ui/button";

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  action?: () => void;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed bg-card p-8 text-center">
      <Icon className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? (
        <Button className="mt-5" onClick={action}>
          Add record
        </Button>
      ) : null}
    </div>
  );
}
