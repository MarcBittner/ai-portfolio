"use client";

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// The multi-series overlay chart — a thin uPlot wrapper. uPlot (~20 KB, canvas)
// is the right tool for dense time-series overlays where SVG libraries melt past
// a few thousand points. This module is loaded ONLY via next/dynamic({ssr:false})
// from page.tsx, so uPlot + its CSS never enter the main bundle.
//
// Theming: uPlot takes explicit stroke colors, so we read the CSS-variable accents
// (--color-accent, --color-line, --color-ink, --color-muted, + the palette) at
// mount and on every redraw, so it inherits the trueline theme + accent switching.
// Per-unit y-axes: series are grouped by unit onto separate scales (mixing ms and
// count on one axis is meaningless).

export type ChartSeries = {
  key: string;
  metric: string;
  unit: string;
  instanceId?: string;
  resource?: string;
  values: (number | null)[];
};

export type ChartData = {
  timestamps: number[]; // seconds? no — ms; converted to s for uPlot below
  series: ChartSeries[];
};

// A small, theme-independent palette for distinguishing many overlaid series.
// The first series always uses the live accent; the rest cycle these hues (read
// from the CSS custom props so they track the theme's ok/warn/bad + accents).
const PALETTE_VARS = [
  "--color-accent",
  "--color-ok",
  "--color-warn",
  "--color-bad",
];

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// A deterministic extra hue for series beyond the themed palette, so a 10-series
// overlay stays distinguishable. oklch spun around the wheel by index.
function spun(i: number): string {
  const hue = (i * 47) % 360;
  return `oklch(0.74 0.14 ${hue})`;
}

export default function ObservabilityChart({
  data,
  height = 320,
  autoScale = false,
}: {
  data: ChartData;
  height?: number;
  // When true, fit the axes to the LOADED data: Y to each unit's visible min/max
  // (padded), X to the tightest window containing the returned points. Default
  // false → uPlot's normal auto (Y from 0-ish, X the full selected window).
  autoScale?: boolean;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Distinct units → one scale each. uPlot draws a y-axis per scale.
  const units = useMemo(() => [...new Set(data.series.map((s) => s.unit))], [data.series]);

  // uPlot AlignedData: [xs, ...ys]. x in seconds (uPlot convention).
  const aligned = useMemo<uPlot.AlignedData>(() => {
    const xs = data.timestamps.map((t) => t / 1000);
    const ys = data.series.map((s) => s.values.map((v) => (v == null ? null : v)));
    return [xs, ...ys] as unknown as uPlot.AlignedData;
  }, [data]);

  // The TIGHTEST x-extent (seconds) that still contains every non-null point —
  // the actual data span, which is usually narrower than the nominal window
  // (leading/trailing null buckets). Null when nothing has landed yet.
  const xExtent = useMemo<[number, number] | null>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of data.series) {
      for (let i = 0; i < s.values.length; i++) {
        if (s.values[i] == null) continue;
        const t = data.timestamps[i];
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    }
    return lo <= hi ? [lo / 1000, hi / 1000] : null;
  }, [data]);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    const muted = cssVar("--color-muted", "#9aa0a6");
    const line = cssVar("--color-line", "#333");

    const strokeFor = (i: number) =>
      i < PALETTE_VARS.length ? cssVar(PALETTE_VARS[i], spun(i)) : spun(i);

    const seriesOpts: uPlot.Series[] = [
      {}, // x
      ...data.series.map((s, i) => ({
        label: seriesLabel(s),
        stroke: strokeFor(i),
        width: 1.5,
        scale: s.unit,
        // Show the unit in the legend value.
        value: (_u: uPlot, v: number | null) => (v == null ? "—" : `${round(v)} ${s.unit}`),
        points: { show: false },
        spanGaps: false, // null buckets render as gaps, not fake lines
      })),
    ];

    // One y-axis per unit (left side, stacked). x-axis time formatting is uPlot's
    // default (localized), which is fine for our windows.
    const axes: uPlot.Axis[] = [
      {
        stroke: muted,
        grid: { stroke: line, width: 0.5 },
        ticks: { stroke: line, width: 0.5 },
        font: "11px ui-monospace, monospace",
      },
      ...units.map((u, i) => ({
        scale: u,
        side: (i % 2 === 0 ? 3 : 1) as 1 | 3, // alternate left(3)/right(1)
        stroke: muted,
        grid: { show: i === 0, stroke: line, width: 0.5 },
        ticks: { stroke: line, width: 0.5 },
        font: "11px ui-monospace, monospace",
        label: u,
        labelFont: "11px ui-monospace, monospace",
        size: 52,
      })),
    ];

    // Y padding for the auto-scale fit: 6% of the visible span (a flat ±1 when a
    // series is constant so the line doesn't hug an edge). Returned to uPlot as a
    // scale `range` fn, which overrides its default auto for that scale.
    const padY = (min: number | null, max: number | null): [number, number] => {
      const lo = min ?? 0;
      const hi = max ?? 1;
      if (lo === hi) return [lo - 1, hi + 1];
      const pad = (hi - lo) * 0.06;
      return [lo - pad, hi + pad];
    };

    const scales: uPlot.Scales = { x: { time: true } };
    // Auto-scale X: clamp the time scale to the actual data extent (tightest
    // window containing points), not the nominal selected window. The extent is
    // applied imperatively via setScale in the data-refresh effect below (not
    // baked into a build-time range fn), so a new extent on each 30s poll updates
    // the existing plot instead of forcing a full destroy()/new uPlot() rebuild.
    for (const u of units) {
      scales[u] = autoScale
        ? { auto: true, range: (_u: uPlot, min: number | null, max: number | null) => padY(min, max) }
        : { auto: true };
    }

    const opts: uPlot.Options = {
      width: holder.clientWidth || 640,
      height,
      scales,
      series: seriesOpts,
      axes,
      legend: { show: true },
      cursor: { focus: { prox: 24 }, drag: { x: true, y: false } },
      padding: [8, 8, 0, 8],
    };

    // Rebuild the plot on structural changes (series set / units). setData handles
    // incremental value refreshes without a rebuild (see the second effect).
    plotRef.current?.destroy();
    const plot = new uPlot(opts, aligned, holder);
    plotRef.current = plot;

    const onResize = () => plot.setSize({ width: holder.clientWidth || 640, height });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuild ONLY on structural changes: the series identity or unit set
    // changes, the height changes, or the auto-scale toggle flips (each requires
    // rebuilding the axes/scales/series options). A new data extent on each poll
    // does NOT rebuild — it is applied via setScale in the refresh effect below,
    // so autoScale mode no longer destroy()/new uPlot()s every 30s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.series.map((s) => s.key).join("|"), units.join("|"), height, autoScale]);

  // Incremental data refresh: same series set, new values → setData (no rebuild).
  // In autoScale mode also clamp the x-scale to the current data extent via
  // setScale, so the fitted window tracks each poll without a full rebuild.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // setData(data, false) suppresses uPlot's own auto x-rescale so our explicit
    // setScale below wins; when not autoscaling, setData(data) lets uPlot keep
    // its default x behavior (the full selected window).
    if (autoScale && xExtent) {
      plot.setData(aligned, false);
      plot.setScale("x", { min: xExtent[0], max: xExtent[1] });
    } else {
      plot.setData(aligned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligned, autoScale, xExtent?.[0], xExtent?.[1]]);

  if (data.series.length === 0) {
    return (
      <div
        className="glass flex items-center justify-center text-sm text-[--color-muted]"
        style={{ height }}
      >
        Select one or more metrics to overlay.
      </div>
    );
  }

  return <div className="glass p-2" ref={holderRef} style={{ width: "100%" }} />;
}

function seriesLabel(s: ChartSeries): string {
  const scope = s.instanceId ?? s.resource;
  return scope ? `${s.metric} · ${scope}` : s.metric;
}

function round(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}
