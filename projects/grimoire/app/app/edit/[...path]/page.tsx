import { notFound } from "next/navigation";

import { Editor } from "@/app/components/editor";
import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { currentPrincipal, db, getReadableDoc } from "@/lib/server/data";

export const dynamic = "force-dynamic";

// Edit view — authorized server-side for `edit` on the path. A denied/missing doc
// is a 404 (no existence signal). The Editor (client) calls the save server action,
// which re-checks authorization — the page gate is UX, the action gate is security.
export default async function EditPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const docPath = path.map(decodeURIComponent).join("/");

  const principal = await currentPrincipal();
  if (!principal) notFound();
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path: docPath, spaceKey: spaceKeyOf(docPath) },
    "edit",
  );
  if (!decision.allowed) notFound();

  const doc = await getReadableDoc(docPath);
  if (!doc) notFound();

  return (
    <Editor
      path={docPath}
      initialContent={doc.body}
      baseSha={doc.blobSha}
      title={doc.title}
      userName={principal.email.split("@")[0]}
    />
  );
}
