import { SkeletonBar } from "../../../components/skeleton";

// Route-segment loading skeleton for the instance-detail page (perf-plan §Area 3 · P1).
// Content-shaped placeholder that matches the detail shell (max-w-5xl px-6 py-8):
// a back-link/actions row, a header card, and the 3 summary cards — so the layout
// doesn't shift when the real server-rendered content swaps in. Static markup only
// (CSS animation), no "use client", so it adds nothing to the client bundle.
export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8" aria-busy="true" aria-live="polite">
      {/* Nav placeholder — a thin bar where the tab strip renders. */}
      <SkeletonBar className="mb-6 h-9 w-full max-w-md" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <SkeletonBar className="h-4 w-28" />
        <SkeletonBar className="h-8 w-40" />
      </div>
      {/* Header card. */}
      <div className="glass mb-4 p-5">
        <SkeletonBar className="h-6 w-64" />
        <SkeletonBar className="mt-3 h-3 w-40" />
      </div>
      {/* Three summary cards. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass p-4">
            <SkeletonBar className="mb-3 h-4 w-24" />
            {Array.from({ length: 5 }).map((_, j) => (
              <SkeletonBar key={j} className="mb-2 h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading instance…</span>
    </main>
  );
}
