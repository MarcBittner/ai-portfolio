import { withOperator, ok, bad, safeRead, cachedRead } from "@/lib/api";
import { listTemplates, createTemplate, deleteTemplate, type NewTemplate } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/templates — reproducible instance recipes (B-8). Safe to browser-cache:
// slow-changing, not polled, and the same recipe list for every operator — so
// cachedRead (post-RBAC) adds ETag/304 + a browser-private Cache-Control here too.
export async function GET() {
  return withOperator(() =>
    safeRead("templates unavailable", { templates: [] }, async () =>
      cachedRead({ templates: await listTemplates() }),
    ),
  );
}

// POST /api/templates — capture a new template.
export async function POST(req: Request) {
  return withOperator(async () => {
    const body = (await req.json()) as NewTemplate;
    return ok({ template: await createTemplate(body) });
  }, "write");
}

// DELETE /api/templates?id=... — drop a template. The `id` presence check lives
// INSIDE withOperator so authentication is proven before any request-shape
// feedback (a 401 for an unauthenticated caller, not a 400 param oracle) [API-4].
export async function DELETE(req: Request) {
  return withOperator(async () => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return bad("id required");
    await deleteTemplate(id);
    return ok({ deleted: id });
  }, "write");
}
