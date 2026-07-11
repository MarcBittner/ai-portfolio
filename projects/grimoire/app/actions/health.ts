"use server";

import { extractDocLinks } from "@/lib/backlinks";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

// Content health — governance signal over the docs you can read: which are stale
// (not touched in a while), orphaned (nothing links to them), or short/stubby.
// Permission-scoped to the readable set (never leaks). Read-only analysis.

const STALE_DAYS = 120;
const STUB_CHARS = 400;

export interface HealthItem {
  path: string;
  title: string;
  spaceKey: string;
  updatedAt: number;
  ageDays: number;
  backlinks: number;
  chars: number;
  flags: string[]; // any of: "stale", "orphaned", "stub"
}

export interface HealthReport {
  total: number;
  stale: number;
  orphaned: number;
  stub: number;
  items: HealthItem[]; // flagged items, worst first
}

export async function getContentHealth(): Promise<HealthReport | { error: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { error: "Not signed in." };

  const readable = await listReadableDocs();
  const readableSet = new Set(readable.map((d) => d.path));
  const rows = (await repos(await db()).docs.find()).filter((d) => readableSet.has(d.path));

  // Inbound link counts, computed once over the readable corpus (O(n)).
  const knownNoExt = new Map<string, string>(); // normalized(no-ext) -> path
  for (const d of rows) {
    knownNoExt.set(d.path.replace(/\.mdx?$/, ""), d.path);
  }
  const inbound = new Map<string, number>();
  for (const d of rows) {
    const seen = new Set<string>();
    for (const link of extractDocLinks(d.body)) {
      const target = knownNoExt.get(link.replace(/\.mdx?$/, ""));
      if (target && target !== d.path && !seen.has(target)) {
        seen.add(target);
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
  }

  const now = Date.now();
  const items: HealthItem[] = [];
  for (const d of rows) {
    const ageDays = Math.floor((now - (d.updatedAt || now)) / 86_400_000);
    const backlinks = inbound.get(d.path) ?? 0;
    const chars = (d.body ?? "").length;
    const flags: string[] = [];
    if (ageDays > STALE_DAYS) flags.push("stale");
    if (backlinks === 0) flags.push("orphaned");
    if (chars < STUB_CHARS) flags.push("stub");
    if (flags.length > 0) {
      items.push({
        path: d.path,
        title: d.title,
        spaceKey: d.spaceKey,
        updatedAt: d.updatedAt,
        ageDays,
        backlinks,
        chars,
        flags,
      });
    }
  }
  // Worst first: more flags, then older.
  items.sort((a, b) => b.flags.length - a.flags.length || b.ageDays - a.ageDays);

  return {
    total: rows.length,
    stale: items.filter((i) => i.flags.includes("stale")).length,
    orphaned: items.filter((i) => i.flags.includes("orphaned")).length,
    stub: items.filter((i) => i.flags.includes("stub")).length,
    items,
  };
}
