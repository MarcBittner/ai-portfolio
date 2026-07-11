import { notFound } from "next/navigation";
import GithubSlugger from "github-slugger";

import { DocReadEdit, type DocViewData } from "@/app/components/doc-read-edit";
import { DocArticle } from "@/app/components/doc-article";
import type { TocItem } from "@/app/components/doc-aside";
import { authorize } from "@/lib/authz";
import { isFavorite } from "@/app/actions/favorites";
import { currentPrincipal, db, getReadableDoc } from "@/lib/server/data";
import { stripFrontmatter, extractHeadings } from "@/lib/markdown";

export const dynamic = "force-dynamic";

// Doc view — reading + in-place editing share ONE view. A denied/missing doc is a
// 404 (no existence signal), preserving the no-leak guarantee. Edit rights are
// resolved server-side; the client toggles the article↔editor without navigating.
export default async function DocPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const docPath = path.map(decodeURIComponent).join("/");
  const doc = await getReadableDoc(docPath);
  if (!doc) notFound();

  const principal = await currentPrincipal();
  const canEdit = principal
    ? (
        await authorize(
          await db(),
          principal.email,
          { type: "doc", path: doc.path, spaceKey: doc.spaceKey },
          "edit",
        )
      ).allowed
    : false;

  const body = stripFrontmatter(doc.body);
  const slugger = new GithubSlugger();
  const toc: TocItem[] = extractHeadings(body)
    .filter((h) => h.depth >= 2 && h.depth <= 3)
    .map((h) => ({ depth: h.depth, text: h.text, slug: slugger.slug(h.text) }));

  const view: DocViewData = {
    path: doc.path,
    title: doc.title,
    spaceKey: doc.spaceKey,
    raw: doc.body,
    blobSha: doc.blobSha,
    updatedAt: doc.updatedAt,
    source: doc.source,
    status: doc.status,
    owner: doc.owner,
    tags: doc.tags,
    summary: doc.summary,
  };

  const favorite = principal ? await isFavorite(doc.path) : false;

  return (
    <DocReadEdit
      doc={view}
      toc={toc}
      canEdit={canEdit}
      userName={principal?.email.split("@")[0]}
      favorite={favorite}
      // Body rendered server-side (RSC) and streamed as HTML — the markdown
      // toolchain never reaches the client bundle. Read path = server HTML.
      article={<DocArticle body={body} />}
    />
  );
}
