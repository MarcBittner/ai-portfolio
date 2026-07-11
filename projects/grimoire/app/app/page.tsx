import Link from "next/link";
import { FileText, FolderTree } from "lucide-react";

import { Badge, Card } from "@/app/components/ui";
import { listReadableDocs, type DocListing } from "@/lib/server/data";

// Live dashboard — renders the permission-filtered doc index from the backend
// (Mongo Atlas in prod, bootstrapped from the repo). Dynamic so it reflects the
// current store + identity per request rather than being baked at build time.
export const dynamic = "force-dynamic";

function groupBySpace(docs: DocListing[]): Map<string, DocListing[]> {
  const m = new Map<string, DocListing[]>();
  for (const d of docs) {
    const list = m.get(d.spaceKey) ?? [];
    list.push(d);
    m.set(d.spaceKey, list);
  }
  return m;
}

export default async function Dashboard() {
  let docs: DocListing[] = [];
  let error: string | null = null;
  try {
    docs = await listReadableDocs();
  } catch (e) {
    error = e instanceof Error ? e.message : "failed to load docs";
  }
  const spaces = groupBySpace(docs);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
        <Badge tone={docs.length ? "ok" : "accent"}>
          {docs.length ? `${docs.length} docs` : "empty"}
        </Badge>
      </div>

      {error && (
        <Card className="mb-4 border-[--color-bad]">
          <p className="text-sm text-[--color-bad]">Couldn’t load the index: {error}</p>
        </Card>
      )}

      {docs.length === 0 && !error ? (
        <Card>
          <FolderTree size={18} className="text-[--color-accent]" aria-hidden />
          <h2 className="mt-3 text-sm font-semibold">No docs yet</h2>
          <p className="mt-1 text-sm text-[--color-muted]">
            Point <code>MONGODB_URI</code> at your store, or add Markdown under{" "}
            <code>content/</code> — the index bootstraps on load. With zero keys it
            runs against an in-memory store.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...spaces.entries()].map(([space, list]) => (
            <Card key={space}>
              <div className="flex items-center gap-2">
                <FolderTree size={16} className="text-[--color-accent]" aria-hidden />
                <h2 className="text-sm font-semibold">{space}</h2>
                <Badge tone="muted">{list.length}</Badge>
              </div>
              <ul className="mt-3 space-y-1.5">
                {list.map((d) => (
                  <li key={d.path}>
                    <Link
                      href={`/app/doc/${d.path}`}
                      prefetch
                      className="flex items-center gap-2 text-sm text-[--color-ink] hover:text-[--color-accent]"
                    >
                      <FileText size={14} className="text-[--color-muted]" aria-hidden />
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
