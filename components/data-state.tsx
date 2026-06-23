export function LoadingState() {
  return (
    <div className="rounded-lg border bg-card p-8 text-center text-sm font-medium text-muted-foreground shadow-operational">
      Loading data…
    </div>
  );
}

export function LoadErrorState({ onRetry, detail }: { onRetry: () => void; detail?: string | null }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center shadow-operational">
      <p className="font-semibold text-destructive">Failed to load data from Supabase</p>
      <p className="mt-2 text-sm text-muted-foreground">Check the project credentials, database schema, and network connection.</p>
      {detail ? <p className="mx-auto mt-2 max-w-2xl text-xs text-muted-foreground">{detail}</p> : null}
      <button className="mt-4 rounded-md border bg-background px-4 py-2 text-sm font-medium" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
