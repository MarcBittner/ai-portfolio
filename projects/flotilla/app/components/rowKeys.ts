// Pure row-keying + memo helpers for the dashboard lists (perf-plan §Area: stop
// re-rendering the whole list on every poll).
//
// Two problems these fix:
//   1. Index keys (`key={i}`) — when SWR polls and the list reorders or an item is
//      inserted/removed, React reuses the wrong DOM nodes and re-renders every row.
//      `rowKey` returns a STABLE key from a real id field so React can match rows
//      across polls and only touch the ones that changed.
//   2. Whole-list re-render — wrapping each row in `React.memo(sameRow)` means a
//      poll that returns a reference-equal row object skips that row entirely.
//
// Kept as a plain `.ts` module (no JSX) so it's covered by the existing node-env
// vitest suite without adding a DOM test runner.

/**
 * Derive a stable React key for a row from a real id field — NEVER the array
 * index. Tries the given `idFields` in order; falls back to a deterministic index
 * only as an explicit last resort (and only if you pass one).
 *
 * @param row       the row object
 * @param idFields  candidate id fields, in preference order (default: ["id"])
 * @param fallbackIndex last-resort key if no id field is present (stringified)
 */
export function rowKey(
  row: Record<string, unknown>,
  idFields: string[] = ["id"],
  fallbackIndex?: number,
): string {
  for (const f of idFields) {
    const v = row[f];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  if (fallbackIndex !== undefined) return String(fallbackIndex);
  // No id and no fallback: throw in dev-thought but return a best-effort stable
  // string so we never crash a render. Callers with truly id-less rows should pass
  // a fallbackIndex.
  return JSON.stringify(row);
}

/**
 * React.memo comparator for a memoized row component. Returns TRUE when the props
 * are equivalent (React should SKIP the re-render). Compares the row object by
 * reference (SWR hands back a fresh object only for rows that changed) plus any
 * extra scalar props; function props are treated as always-equal because callers
 * pass stable-by-contract callbacks and comparing function identity would defeat
 * the memo on every poll.
 */
export function sameRow(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    // Stable-by-contract callbacks: don't let differing function identities force a
    // re-render (they shouldn't differ if callers memoize, but be defensive).
    if (typeof a === "function" && typeof b === "function") continue;
    return false;
  }
  return true;
}
