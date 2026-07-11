// Server-safe route-segment skeletons (perf-plan §Area 3/4 · P1). Rendered by each
// read-only list segment's loading.tsx while the RSC / first fetch resolves, so a
// slow read shows a content-shaped placeholder instead of the blank-then-everything
// flash. No "use client" — these are static markup (they animate via CSS only), so
// they add nothing to the client bundle.

// A single shimmering bar. `w`/`h` are tailwind width/height utility fragments.
export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[--color-line]/60 ${className}`} />;
}

// A content-shaped placeholder for a titled list/table page: a header row + a
// glass panel of shimmering rows. Matches the max-w-6xl px-6 py-8 shell every tab
// uses so the layout doesn't shift when the real content swaps in.
export function ListPageSkeleton({
  title,
  rows = 6,
}: {
  title: string;
  rows?: number;
}) {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8" aria-busy="true" aria-live="polite">
      {/* Nav placeholder — a thin bar where the tab strip renders. */}
      <SkeletonBar className="mb-6 h-9 w-full max-w-md" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-[--color-muted]">{title}</h1>
        <SkeletonBar className="h-8 w-32" />
      </div>
      <div className="glass p-0">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-[--color-line]/50 px-3 py-3 last:border-0">
            <SkeletonBar className="h-4 w-40" />
            <SkeletonBar className="h-4 w-24" />
            <SkeletonBar className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading {title}…</span>
    </main>
  );
}
