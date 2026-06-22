import { ThemeToggle } from "@/components/theme-toggle";

export function Header() {
  return (
    <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Sysco / Replenishment</p>
        <h1 className="text-xl font-semibold">CR028 - Delivery Date Range</h1>
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden rounded-md border bg-card px-3 py-2 text-sm font-medium text-muted-foreground sm:inline-flex">
          Discovery
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
