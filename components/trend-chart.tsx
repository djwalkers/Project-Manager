"use client";

import { useState } from "react";
import type { ProjectSnapshot } from "@/lib/types";

// Legacy single-series chart (kept for backwards compat with risk-trend page, etc.)
export type TrendPoint = { date: string; value: number };

export function TrendChart({
  title,
  description,
  points,
  color = "#2563eb",
  suffix = "",
}: {
  title: string;
  description: string;
  points: TrendPoint[];
  color?: string;
  suffix?: string;
}) {
  if (!points.length) return null;

  const W = 280;
  const H = 80;
  const PAD = { left: 28, right: 8, top: 8, bottom: 16 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxV = Math.max(...points.map((p) => p.value), 1);
  const xAt = (i: number) => PAD.left + (i / Math.max(points.length - 1, 1)) * chartW;
  const yAt = (v: number) => PAD.top + chartH - (v / maxV) * chartH;
  const pts = points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(" ");
  const last = points[points.length - 1];

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label={title} role="img">
        {[0, Math.round(maxV / 2), maxV].map((v) => (
          <line key={v} x1={PAD.left} x2={PAD.left + chartW} y1={yAt(v)} y2={yAt(v)}
            stroke="currentColor" strokeOpacity="0.08" strokeWidth="0.5" />
        ))}
        {[0, Math.round(maxV / 2), maxV].map((v) => (
          <text key={v} x={PAD.left - 3} y={yAt(v) + 3} textAnchor="end"
            fontSize="6" fill="currentColor" fillOpacity="0.45">{v}{suffix}</text>
        ))}
        {[0, points.length - 1].map((i) => (
          <text key={i} x={xAt(i)} y={H - 2}
            textAnchor={i === 0 ? "start" : "end"}
            fontSize="6" fill="currentColor" fillOpacity="0.4">
            {points[i].date.slice(5)}
          </text>
        ))}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xAt(points.length - 1)} cy={yAt(last.value)} r="2.5" fill={color} />
      </svg>
    </div>
  );
}

// ── Multi-series snapshot-based charts ────────────────────────────────────────

type NumericSnapshotKey = {
  [K in keyof ProjectSnapshot]: ProjectSnapshot[K] extends number | null ? K : never;
}[keyof ProjectSnapshot];

export type SnapshotSeries = {
  key: NumericSnapshotKey;
  label: string;
  color: string;
};

type MultiChartProps = {
  snapshots: ProjectSnapshot[];
  series: SnapshotSeries[];
  title: string;
  yMax?: number;
  yPercent?: boolean;
};

export function SnapshotChart({ snapshots, series, title, yMax, yPercent }: MultiChartProps) {
  const sorted = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );

  if (sorted.length < 2) {
    return (
      <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
        Need ≥2 snapshots in range
      </div>
    );
  }

  const W = 280;
  const H = 90;
  const PAD = { left: 28, right: 8, top: 8, bottom: 18 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const allVals = series.flatMap((s) => sorted.map((snap) => Number(snap[s.key] ?? 0)));
  const max = yMax ?? Math.max(...allVals, 1);

  const xAt = (i: number) => PAD.left + (i / (sorted.length - 1)) * chartW;
  const yAt = (v: number) => PAD.top + chartH - (v / max) * chartH;

  const yLines = yPercent ? [0, 50, 100] : [0, Math.round(max / 2), max];
  const fmt = (v: number) => (yPercent ? `${v}` : String(Math.round(v)));

  const xLabels =
    sorted.length <= 7
      ? sorted.map((_, i) => i)
      : [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1];

  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted-foreground">{title}</p>
      <div className="mb-1 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label={title} role="img">
        {yLines.map((v) => (
          <line key={v} x1={PAD.left} x2={PAD.left + chartW}
            y1={yAt(v)} y2={yAt(v)} stroke="currentColor" strokeOpacity="0.08" strokeWidth="0.5" />
        ))}
        {yLines.map((v) => (
          <text key={v} x={PAD.left - 3} y={yAt(v) + 3} textAnchor="end"
            fontSize="6" fill="currentColor" fillOpacity="0.45">{fmt(v)}</text>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={xAt(i)} y={H - 3}
            textAnchor={i === 0 ? "start" : i === sorted.length - 1 ? "end" : "middle"}
            fontSize="6" fill="currentColor" fillOpacity="0.45">
            {sorted[i].snapshot_date.slice(5)}
          </text>
        ))}
        {series.map((s) => {
          const pts = sorted
            .map((snap, i) => `${xAt(i)},${yAt(Number(snap[s.key] ?? 0))}`)
            .join(" ");
          const last = sorted[sorted.length - 1];
          return (
            <g key={s.key}>
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={xAt(sorted.length - 1)} cy={yAt(Number(last[s.key] ?? 0))}
                r="2.5" fill={s.color} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Trends panel with range toggle ───────────────────────────────────────────

type DayRange = 7 | 30 | 0;

const RANGES: { label: string; value: DayRange }[] = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "All", value: 0 },
];

function filterByRange(snapshots: ProjectSnapshot[], days: DayRange) {
  if (days === 0) return snapshots;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return snapshots.filter((s) => s.snapshot_date >= cutoff.toISOString().slice(0, 10));
}

export function ProjectTrendsPanel({ snapshots }: { snapshots: ProjectSnapshot[] }) {
  const [range, setRange] = useState<DayRange>(30);
  const visible = filterByRange(snapshots, range);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Project Trends</p>
        <div className="flex gap-1 rounded-md border bg-muted/40 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRange(r.value)}
              className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                range === r.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <SnapshotChart
          snapshots={visible}
          title="Delivery Confidence"
          series={[
            { key: "delivery_confidence", label: "Confidence", color: "#3b82f6" },
            { key: "project_readiness", label: "Readiness", color: "#8b5cf6" },
          ]}
          yMax={100}
          yPercent
        />
        <SnapshotChart
          snapshots={visible}
          title="Risk Trend"
          series={[
            { key: "high_risks", label: "High / Critical", color: "#ef4444" },
            { key: "open_risks", label: "All Open", color: "#f97316" },
          ]}
        />
        <SnapshotChart
          snapshots={visible}
          title="Actions Trend"
          series={[
            { key: "open_actions", label: "Open", color: "#f59e0b" },
            { key: "blocked_actions", label: "Blocked", color: "#ef4444" },
          ]}
        />
        <SnapshotChart
          snapshots={visible}
          title="Requirements Progress"
          series={[{ key: "requirements_complete", label: "Complete", color: "#22c55e" }]}
        />
        <SnapshotChart
          snapshots={visible}
          title="Acceptance Progress"
          series={[
            { key: "acceptance_complete", label: "Met / Waived", color: "#22c55e" },
            { key: "evidence_complete", label: "Evidence", color: "#3b82f6" },
          ]}
        />
        <SnapshotChart
          snapshots={visible}
          title="Sign-off Progress"
          series={[{ key: "sign_off_complete", label: "Approved", color: "#22c55e" }]}
        />
      </div>
    </div>
  );
}
