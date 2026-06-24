import { formatScheduleDate } from "@/lib/schedule";

export type TrendPoint = { date: string; value: number };

export function TrendChart({ title, description, points, color = "#2563eb", suffix = "" }: { title: string; description: string; points: TrendPoint[]; color?: string; suffix?: string }) {
  const values = points.map((point) => point.value);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 0;
  const padding = Math.max(1, (maxValue - minValue) * 0.15);
  const min = minValue - padding;
  const max = maxValue + padding;
  const width = 600;
  const height = 180;
  const left = 36;
  const right = 16;
  const top = 16;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const coordinates = points.map((point, index) => ({
    ...point,
    x: left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    y: top + ((max - point.value) / Math.max(1, max - min)) * plotHeight,
  }));

  return (
    <figure className="w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-card p-4 shadow-operational">
      <figcaption><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></figcaption>
      {!points.length ? (
        <div className="mt-4 rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">No snapshot values yet.</div>
      ) : (
        <>
          <div className="mt-4 min-w-0 max-w-full overflow-x-auto">
            <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[520px]" role="img" aria-label={`${title}: ${points.map((point) => `${point.date} ${point.value}${suffix}`).join(", ")}`}>
              {[0, 0.5, 1].map((ratio) => <line key={ratio} x1={left} x2={width - right} y1={top + ratio * plotHeight} y2={top + ratio * plotHeight} stroke="currentColor" className="text-border" strokeWidth="1" />)}
              {minValue <= 0 && maxValue >= 0 ? <line x1={left} x2={width - right} y1={top + ((max - 0) / Math.max(1, max - min)) * plotHeight} y2={top + ((max - 0) / Math.max(1, max - min)) * plotHeight} stroke="currentColor" className="text-muted-foreground" strokeDasharray="5 5" /> : null}
              {coordinates.length > 1 ? <polyline fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={coordinates.map((point) => `${point.x},${point.y}`).join(" ")} /> : null}
              {coordinates.map((point) => <g key={point.date}><circle cx={point.x} cy={point.y} r="5" fill={color} stroke="white" strokeWidth="2" /><text x={point.x} y={Math.max(12, point.y - 10)} textAnchor="middle" fontSize="11" fill="currentColor">{point.value}{suffix}</text><text x={point.x} y={height - 8} textAnchor="middle" fontSize="10" fill="currentColor">{point.date.slice(5)}</text></g>)}
            </svg>
          </div>
          <div className="mt-3 min-w-0 max-w-full overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3">Date</th>{points.map((point) => <th key={point.date} className="px-2 py-2 text-right">{formatScheduleDate(point.date)}</th>)}</tr></thead><tbody><tr><th className="py-2 pr-3 text-left font-medium">Value</th>{points.map((point) => <td key={point.date} className="px-2 py-2 text-right font-semibold tabular-nums">{point.value}{suffix}</td>)}</tr></tbody></table>
          </div>
        </>
      )}
    </figure>
  );
}
