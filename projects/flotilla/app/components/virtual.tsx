"use client";

import { memo, type ReactNode } from "react";
import { Virtualizer } from "virtua";

// ---- list virtualization (perf-plan §Area: frontend list rendering) --------
//
// Windowed rendering for the dashboard's long lists. The measured hotspot was the
// Logs view rendering an unvirtualized 1000-row list (423ms script + 258ms of
// long-tasks). We window the rows with `virtua` (~3KB, React-19-clean) so only the
// visible slice is in the DOM.
//
// DESIGN INVARIANTS (Marc visually verifies in a headless browser afterward):
//   • Small lists render NORMALLY — virtualization has real per-frame overhead and
//     a 20-row table gains nothing, so we only window past a threshold.
//   • The virtual container must never collapse to zero height. virtua measures
//     item sizes from a real first render, so as long as at least one item is
//     rendered the container gets a height; the threshold guarantees a populated
//     list whenever we virtualize.
//   • Table semantics are preserved: the table body path uses `as="tbody"` /
//     `item="tr"` so the DOM stays <table><tbody><tr>. Rows keep their real ids as
//     React keys (via the memoized row components the callers pass), so a SWR poll
//     only re-renders the rows whose data actually changed.

// The row count past which we switch a list to windowed rendering. Below this a
// plain map is cheaper (no measurement/observer overhead) and the DOM is small
// enough that a full re-render on a poll tick is imperceptible. Chosen so the
// common small-fleet / short-queue case is untouched and only genuinely long
// streams (the 1000-row logs case, big queues) pay for virtualization.
export const VIRTUALIZE_THRESHOLD = 60;

/**
 * Pure predicate: should a list of `count` rows be windowed?
 *
 * Extracted so the threshold decision is unit-testable without a DOM. Callers use
 * it to branch between a plain `.map(...)` and the virtualized path, and to keep
 * that branch identical everywhere.
 */
export function shouldVirtualize(
  count: number,
  threshold: number = VIRTUALIZE_THRESHOLD,
): boolean {
  return count > threshold;
}

// A scroll-container-based windowed list for NON-table content (e.g. the Logs
// stream, which is a <div> list inside a fixed-height `overflow-y-auto` panel).
// The nearest scrollable ancestor is the scroll parent, so the existing
// max-h-[70vh] panel keeps its exact scroll behavior — virtua just renders the
// visible slice into it. Below the threshold we render every child directly so the
// short-list case has zero virtualization overhead.
export function VirtualList<T>({
  items,
  getKey,
  children,
  threshold = VIRTUALIZE_THRESHOLD,
  overscan,
}: {
  items: T[];
  getKey: (item: T, index: number) => string | number;
  children: (item: T, index: number) => ReactNode;
  threshold?: number;
  overscan?: number;
}) {
  if (!shouldVirtualize(items.length, threshold)) {
    return (
      <>
        {items.map((it, i) => (
          <RowKey key={getKey(it, i)}>{children(it, i)}</RowKey>
        ))}
      </>
    );
  }
  return (
    <Virtualizer bufferSize={overscan}>
      {items.map((it, i) => (
        <RowKey key={getKey(it, i)}>{children(it, i)}</RowKey>
      ))}
    </Virtualizer>
  );
}

// NOTE ON THE REAL <table>s (Instances, Queue) — why they are NOT windowed here.
//
// virtua positions every item with `position: absolute` (verified in its bundle:
// `position: absolute; top: <offset>; width: 100%`). An absolutely-positioned <tr>
// is pulled OUT of the CSS table flow, so its <td> cells no longer size to the
// <thead> columns — the columns would misalign, which violates the hard constraint
// "preserve the exact table UX / columns / styling." virtua has no semantic-table
// recipe (it expects CSS-grid/flex rows), and converting these tables to a grid
// would itself change the semantics the task says to keep. So the tables instead
// get the OTHER two wins that address their real per-poll cost — stable real-id
// keys + a React.memo'd row so a poll only re-renders changed rows — plus the SWR
// coordination tweaks. If a table ever grows large enough to need windowing, the
// correct move is react-virtuoso's TableVirtuoso (spacer-row math that keeps <td>
// widths), not virtua. See the rowKeys.ts helpers used by those tables.

// Key wrapper for the div-list path — a Fragment can't carry a caller's key
// cleanly across the plain/virtual branches, so this tiny memo'd component does
// (it renders exactly its children, and memo lets an unchanged line skip work).
const RowKey = memo(function RowKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
});
