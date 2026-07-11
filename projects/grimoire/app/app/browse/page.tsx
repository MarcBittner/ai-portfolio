import { getBrowseDocs } from "@/app/actions/browse";
import { BrowseList } from "@/app/components/browse-list";

// Browse & filter — one place to see every doc the current user can read, with
// client-side filtering/sorting over the permission-scoped set. Dynamic so the
// readable set is resolved per request (it depends on the acting principal).
export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const docs = await getBrowseDocs();
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-[--color-muted]">
          Every doc you can read, in one place. Filter by space, status, or tag —
          and sort to taste.
        </p>
      </div>
      <BrowseList docs={docs} />
    </div>
  );
}
