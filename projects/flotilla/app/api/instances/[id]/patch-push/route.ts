import { withOperator, ok, bad } from "@/lib/api";
import { getInstance, getFeatureFlags, recordAudit } from "@/lib/models";
import { githubPushConfigured } from "@/lib/clients/github";
import { enqueuePatchPush } from "@/lib/jobs";
import { patchPushGuard, validatePatch, PATCH_LIMITS } from "@/lib/patchPush";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/instances/[id]/patch-push — upload a unified diff (`.patch`/`.diff`) and
// push it to a running instance: the worker applies it on top of the instance's
// base branch as an ephemeral commit/branch and redeploys the instance's OWN
// disposable target (lib/patchPush.ts). Returns {jobId}; the browser tails the
// existing SSE log stream for progress.
//
// Accepts EITHER multipart/form-data (`file` = the .patch, optional `note`) —
// mirroring the backups upload — OR application/json ({ diff, filename?, note? }).
//
// Gated in layers (same shape as the fix-loop route):
//   1. operator auth (withOperator, "write" — see RBAC note below)
//   2. patchPush feature flag (403 when off)
//   3. GITHUB_TOKEN present for push (409 when absent)
//   4. instance scope guard — tool-created + not prod/shared (409/404)
//   5. patch validation — size / binary / well-formed unified diff (400)
// Every enqueue is stamped in the audit trail.
//
// RBAC = "write" (not "admin"): a patch push mutates only a DISPOSABLE,
// tool-created preview/staging target — never prod or a shared deployment (the
// guard + the executor preflight both enforce that). It is the same mutation
// class as update / reprovision / fix-loop-adopt, all "write". "admin" is
// reserved for role + config management, not per-instance code changes.
type Ctx = { params: Promise<{ id: string }> };

async function readPatch(req: Request): Promise<{ diff: string; filename?: string; note?: string } | { error: string }> {
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { diff?: unknown; filename?: unknown; note?: unknown };
    if (typeof body.diff !== "string") return { error: "diff (unified patch text) required" };
    return {
      diff: body.diff,
      filename: typeof body.filename === "string" ? body.filename : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
    };
  }
  // Default: multipart/form-data with the uploaded file.
  const form = await req.formData().catch(() => null);
  if (!form) return { error: "expected multipart/form-data with a `file`, or application/json { diff }" };
  const file = form.get("file");
  if (!(file instanceof File)) return { error: "file (a .patch/.diff) required" };
  // Cheap pre-read size gate so we never buffer a huge upload into memory.
  if (file.size > PATCH_LIMITS.maxBytes) {
    return { error: `patch too large (${file.size} bytes > ${PATCH_LIMITS.maxBytes})` };
  }
  const diff = await file.text();
  const note = form.get("note") ? String(form.get("note")) : undefined;
  return { diff, filename: file.name, note };
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).patchPush) {
      return bad("patchPush feature is disabled", 403);
    }
    if (!githubPushConfigured()) {
      return bad("GITHUB_TOKEN not configured — a push-scoped token is required to apply patches", 409);
    }

    // Re-derive the full scope guard here so a disallowed instance 4xxs before we
    // even read the upload body.
    const inst = await getInstance(id).catch(() => null);
    const guard = patchPushGuard(inst);
    if (!guard.ok) return bad(guard.reason, inst ? 409 : 404);

    const parsed = await readPatch(req);
    if ("error" in parsed) return bad(parsed.error);

    // Validate here too (the out-of-band gate) so a malformed diff 400s at the
    // edge — enqueuePatchPush re-validates as defense in depth.
    const v = validatePatch(parsed.diff);
    if (!v.ok) return bad(`invalid patch: ${v.reason}`);

    const res = await enqueuePatchPush(id, { patch: parsed.diff, filename: parsed.filename, note: parsed.note });
    if ("error" in res) return bad(res.error, 409);
    await recordAudit(
      principal.id,
      "instance.patch-push",
      id,
      `${inst!.name}: ${parsed.filename ?? "patch"} (${v.stats.files} file(s), ${v.stats.hunks} hunk(s))`,
    ).catch(() => {});
    return ok({ jobId: res.jobId, instanceId: res.instanceId, files: v.stats.files, hunks: v.stats.hunks });
  }, "write");
}
