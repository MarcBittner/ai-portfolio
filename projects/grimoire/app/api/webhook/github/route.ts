import { NextResponse } from "next/server";

import { changedMarkdownPaths, isTrackedBranch, verifyGitHubSignature } from "@/lib/git/webhook";
import { applyPushChanges } from "@/lib/git/indexer";
import { db, store } from "@/lib/server/data";

export const dynamic = "force-dynamic";

// Two-way sync: GitHub push → re-index the changed paths from the source repo so
// external edits land in the app. Signature-verified; only `push` events act.
export async function POST(req: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const raw = await req.text();
  if (!verifyGitHubSignature(secret, raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "push") {
    return NextResponse.json({ ok: true, ignored: req.headers.get("x-github-event") });
  }

  const payload = JSON.parse(raw);

  // Only pushes to the branch we index from may mutate the projection. A push to
  // any OTHER branch (e.g. a feature branch that deletes a doc) must not prune a
  // doc that still exists on the docs branch — that would drift DB from Git.
  const branch = process.env.DOCS_BRANCH ?? "main";
  if (!isTrackedBranch(payload.ref, branch)) {
    return NextResponse.json({ ok: true, ignored: `ref ${payload.ref ?? "(none)"}` });
  }

  const contentRoot = process.env.DOCS_CONTENT_ROOT ?? "";
  const { changed, removed } = changedMarkdownPaths(payload, contentRoot);

  const database = await db();
  const gitStore = store();
  // Reconcile every affected path against the store (removed paths are de-indexed
  // only if genuinely absent — never a blind delete).
  const counts = await applyPushChanges(database, gitStore, changed, removed);
  return NextResponse.json({ ok: true, ...counts });
}
