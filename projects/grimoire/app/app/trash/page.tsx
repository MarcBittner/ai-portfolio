import { Badge } from "@/app/components/ui";
import { TrashList } from "@/app/components/trash-list";
import { listTrash } from "@/app/actions/trash";

export const dynamic = "force-dynamic";

// Trash — soft-deleted docs you can restore. Deletes move the file under the
// _trash/ prefix (still in Git, out of the index); this lists them straight from
// the store, gated on edit rights over the original path (no leaks).
export default async function TrashPage() {
  const items = await listTrash();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <Badge tone={items.length ? "warn" : "muted"}>{items.length}</Badge>
      </div>
      <p className="mb-6 text-sm text-[--color-muted]">
        Deleted docs are kept here and can be restored. Deleting permanently removes
        them from the current version (Git history still retains them).
      </p>
      <TrashList items={items} />
    </div>
  );
}
