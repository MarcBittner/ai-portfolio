import { z } from "zod";
import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getInstance, recordAudit, touchInstanceActivity, updateInstanceOwner } from "@/lib/models";
import { enqueueUpdate, enqueueTeardown } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/instances/:id — one instance's detail (hovercard / detail view).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(() =>
    safeRead("instance unavailable", { instance: null }, async () => {
      const instance = await getInstance(id);
      if (!instance) return bad("not found", 404);
      // Access resets the inactivity TTL for a PR-native instance (guardrail #2c):
      // viewing it counts as activity, so an actively-reviewed PR instance doesn't
      // get reaped out from under a reviewer. Best-effort; only PR instances.
      if (instance.prNumber) void touchInstanceActivity(id).catch(() => {});
      return ok({ instance });
    }),
  );
}

// PATCH /api/instances/:id — update any subset of {branch (code),
// backupSnapshotId+backupDeployment (data), clerkInstance (clerk)} and
// re-provision ONLY the changed dimension(s). ASYNC: returns {jobId}; the worker
// executes. Overwriting a pre-existing deployment requires dangerAck=true.
const PatchBody = z.object({
  branch: z.string().min(1).max(200).optional(),
  backupSnapshotId: z.string().max(200).optional(),
  backupDeployment: z.string().max(120).optional(),
  clerkInstance: z.string().max(120).optional(),
  dangerAck: z.boolean().optional(),
});

// Ownership registry (Track D): reassign owner/team. A metadata-only edit — it does
// NOT re-provision, so it's tunneled through PATCH under `action:"reassign-owner"`
// (the same idiom as `action:"teardown"`) rather than the dimension PatchBody. At
// least one field must be present so an empty reassign is rejected.
const ReassignOwnerBody = z
  .object({
    ownerUserId: z.string().max(200).optional(),
    ownerEmail: z.string().max(320).optional(),
    ownerName: z.string().max(200).optional(),
    team: z.string().max(120).optional(),
  })
  .refine(
    (b) => b.ownerUserId !== undefined || b.ownerEmail !== undefined || b.ownerName !== undefined || b.team !== undefined,
    { message: "reassign-owner requires at least one of ownerUserId, ownerEmail, ownerName, team" },
  );

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    const body = (await req.json()) as Record<string, unknown>;
    // POST-style action tunneled through PATCH is also accepted for teardown, but
    // the canonical teardown verb is DELETE (below). A plain patch re-provisions.
    if (body.action === "teardown") return teardown(id, principal.id, body.dryRun === true);
    // Ownership reassign — metadata-only, write-gated, audited; never re-provisions.
    if (body.action === "reassign-owner") return reassignOwner(id, principal.id, body);
    const patch = PatchBody.parse(body);
    const res = await enqueueUpdate(id, patch);
    if ("error" in res) return bad(res.error, res.error === "instance not found" ? 404 : 400);
    await recordAudit(principal.id, "instance.update", id, `dims=${Object.keys(patch).join(",")}`).catch(() => {});
    return ok({ jobId: res.jobId });
  }, "write");
}

// DELETE /api/instances/:id — one-click TEARDOWN. Enqueues a teardown job that
// reclaims the tool-created Convex/Vercel/Clerk/GridFS resources (worker-side,
// behind the prod/shared guards). Only createdByTool instances; never prod.
// `?action=teardown` POST is also supported via PATCH above for form clients.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "true";
  return withOperator((principal) => teardown(id, principal.id, dryRun), "write");
}

// Ownership registry reassign (Track D). Write-gated (the PATCH handler already
// enforced `write`), audited, metadata-only. Records the before→after owner/team in
// the audit detail so the accounting trail shows who reassigned what. Returns the
// updated instance.
async function reassignOwner(id: string, actor: string, body: Record<string, unknown>): Promise<Response> {
  const assign = ReassignOwnerBody.parse(body);
  const before = await getInstance(id);
  if (!before) return bad("not found", 404);
  const updated = await updateInstanceOwner(id, assign);
  if (!updated) return bad("not found", 404);
  const fromTo = [
    assign.ownerEmail !== undefined ? `owner ${before.ownerEmail ?? "—"}→${updated.ownerEmail ?? "—"}` : null,
    assign.team !== undefined ? `team ${before.team ?? "—"}→${updated.team ?? "—"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  await recordAudit(actor, "instance.owner.reassign", id, fromTo || "owner metadata updated").catch(() => {});
  return ok({ instance: updated });
}

async function teardown(id: string, actor: string, dryRun: boolean): Promise<Response> {
  const res = await enqueueTeardown(id, { dryRun, reason: `requested by ${actor}` });
  if ("error" in res) {
    const status = res.error === "instance not found" ? 404 : 400;
    return bad(res.error, status);
  }
  await recordAudit(actor, "instance.teardown", id, dryRun ? "dry-run" : undefined).catch(() => {});
  return ok({ jobId: res.jobId });
}
