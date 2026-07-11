import { canGlobal } from "@/lib/permissions";
import { currentPrincipal } from "@/lib/server/data";
import { getSources } from "@/app/actions/sources";
import { SourcesPanel } from "@/app/components/sources-panel";

export const dynamic = "force-dynamic";

// Sources & Categorization (FR-30 follow-up). Admins register the content sources
// that feed the wiki and run an AI pass that verifies/refreshes each doc's Space +
// tags, reviewing proposed changes before applying them. Reads are open to any
// signed-in user; writes (save sources / audit / apply) are admin-gated server-side.
export default async function SourcesPage() {
  const principal = await currentPrincipal();
  const editable = !!principal && canGlobal(principal, "managePermissions");
  const sources = await getSources();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sources &amp; Categorization</h1>
      </div>
      <p className="mb-6 text-sm text-[--color-muted]">
        Configure the content sources that feed the wiki, then run an AI pass to verify and
        refresh how docs are filed — reviewing every proposed Space + tag change before it is
        applied. Email &amp; ClickUp ingestion is handled by the external MCP-push integration
        via <code>/api/ingest</code>; this page manages configuration and re-categorization.
      </p>
      <SourcesPanel initialSources={sources} editable={editable} />
    </div>
  );
}
