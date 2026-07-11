import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { loadClerkConfigClient } from "@/lib/loaders";
import { enqueueUpdate } from "@/lib/jobs";
import { SHARED_DEPLOYMENTS } from "@/lib/executor";
import {
  listClerkConfigs,
  getClerkConfig,
  getClerkConfigById,
  upsertClerkConfig,
  saveClerkTemplate,
  markApplied,
  getInstance,
  listInstances,
  recordAudit,
  type ClerkConfigDoc,
  type InstanceDoc,
} from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sensitive Clerk instances — SETTING a target instance's clerk to (or overwriting
// a target that already uses) one of these is a production-auth surface, so it is
// danger-gated exactly like the per-instance user-mutation block in /api/users.
// Kept in sync via the same SENSITIVE_CLERK_INSTANCES env override.
// Env-driven (comma-separated), no org hardcoded. Set SENSITIVE_CLERK_INSTANCES to
// your production/staging Clerk hostnames to danger-gate them; empty = none. Read
// at CALL TIME so the env override actually takes effect at runtime.
function sensitiveClerkInstances(): string[] {
  return (process.env.SENSITIVE_CLERK_INSTANCES || "").split(",").map((s) => s.trim()).filter(Boolean);
}
function isSensitiveClerkInstance(clerkInstance?: string): boolean {
  if (!clerkInstance) return false;
  const c = clerkInstance.toLowerCase();
  return sensitiveClerkInstances().some((s) => c === s.toLowerCase() || c.includes(s.toLowerCase()));
}

// Applying a config to a TARGET instance is dangerous when the target's own write
// deployment is a shared/prod one, OR the clerk instance being applied (or the one
// the target currently uses) is a sensitive prod auth instance. Mirrors the
// UpdateInstancePanel danger guard + the /api/users prod-clerk block; the executor
// preflight is still the hard floor regardless.
function applyDanger(target: InstanceDoc, clerkInstance: string): string | null {
  const dep = target.createdConvexDeployment ?? target.convexDeployment;
  if (dep && SHARED_DEPLOYMENTS[dep]) return `${dep} is the shared "${SHARED_DEPLOYMENTS[dep]}" deployment`;
  if (isSensitiveClerkInstance(clerkInstance)) return `${clerkInstance} is a production Clerk instance`;
  if (isSensitiveClerkInstance(target.clerkInstance)) return `${target.name} currently uses a production Clerk instance`;
  return null;
}

// Annotate each stored config with the live instances that reference its
// clerkInstance (the "which instances use this" signal the hover + detail want).
function withReferences(configs: ClerkConfigDoc[], instances: InstanceDoc[]) {
  return configs.map((c) => ({
    ...c,
    usedBy: instances
      .filter((i) => i.clerkInstance && i.clerkInstance === c.clerkInstance)
      .map((i) => ({ id: i.id, name: i.name })),
  }));
}

// GET /api/clerk               — all stored configs + wizard templates, each with
//                                the instances that reference them (B-7 + wizard).
// GET /api/clerk?instanceId=... — read one instance's live config, refresh drift.
export async function GET(req: Request) {
  const instanceId = new URL(req.url).searchParams.get("instanceId") ?? undefined;
  return withOperator(() =>
    safeRead("clerk config unavailable", { configs: [], templates: [], engine: "stub" }, async () => {
      if (instanceId) {
        const instance = await getInstance(instanceId);
        const clerkInstance = instance?.clerkInstance;
        if (!clerkInstance) return bad("instance has no clerkInstance", 404);
        const { impl, source } = await loadClerkConfigClient();
        const live = await impl.readConfig(clerkInstance);
        const config = await upsertClerkConfig({ instanceId, clerkInstance, config: live });
        return ok({ config, engine: source });
      }
      const [all, instances] = await Promise.all([listClerkConfigs(), listInstances()]);
      const annotated = withReferences(all, instances);
      // `configs` = per-instance drift rows (kept for the fleet page's datalist);
      // `templates` = wizard-created named configs. Both carry `usedBy`.
      return ok({
        configs: annotated.filter((c) => !c.template),
        templates: annotated.filter((c) => c.template),
        instances: instances.map((i) => ({ id: i.id, name: i.name, clerkInstance: i.clerkInstance })),
      });
    }),
  );
}

// POST /api/clerk — reference/apply (B-7) + wizard save + apply-to-instances:
//   { action: "set-reference", instanceId, clerkInstance, reference }
//   { action: "apply", instanceId }                       // Playwright reference-apply (existing)
//   { action: "save-template", name, clerkInstance, params? }
//   { action: "apply", configId|clerkInstance, instanceIds[], dangerAck? }  // apply a config to targets
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;

    if (action === "save-template") {
      const config = await saveClerkTemplate({
        name: (body.name as string) ?? "",
        clerkInstance: (body.clerkInstance as string) ?? "",
        params: (body.params as Record<string, unknown>) ?? undefined,
        createdBy: principal.id,
      });
      await recordAudit(principal.id, "clerk.save-template", config.id, `${config.name} → ${config.clerkInstance}`).catch(() => {});
      return ok({ config });
    }

    if (action === "apply") {
      // NEW: apply a stored config's clerkInstance to one or more TARGET instances,
      // re-provisioning the `clerk` dimension via the shared enqueueUpdate flow.
      const instanceIds = Array.isArray(body.instanceIds) ? (body.instanceIds as string[]) : null;
      if (instanceIds) return applyToInstances(principal.id, body, instanceIds);

      // EXISTING: drive the stored reference onto ONE instance's live Clerk via
      // Playwright (auth-strategy toggles are Dashboard-only). Unchanged.
      const instanceId = body.instanceId as string | undefined;
      if (!instanceId) return bad("instanceId or instanceIds required");
      const stored = await getClerkConfig(instanceId);
      if (!stored) return bad("no stored config for instance", 404);
      const { impl } = await loadClerkConfigClient();
      const res = await impl.applyConfig(stored.clerkInstance, stored.reference);
      if (res.applied) await markApplied(instanceId);
      await recordAudit(principal.id, "clerk.apply", instanceId, `${stored.clerkInstance} applied=${res.applied}`).catch(() => {});
      return ok(res as unknown as Record<string, unknown>);
    }

    if (action === "set-reference") {
      const instanceId = body.instanceId as string | undefined;
      if (!instanceId) return bad("instanceId required");
      const config = await upsertClerkConfig({
        instanceId,
        clerkInstance: (body.clerkInstance as string) ?? "",
        reference: (body.reference as Record<string, unknown>) ?? {},
      });
      await recordAudit(principal.id, "clerk.set-reference", instanceId, config.clerkInstance).catch(() => {});
      return ok({ config });
    }

    return bad("unknown action");
  }, "write");
}

// Apply one config's clerkInstance to a set of target instances. For each target we
// set its `clerkInstance` and enqueue the `clerk`-dimension re-provision through the
// SAME enqueueUpdate flow the fleet page's "Update clerk config" uses — we don't
// reimplement the executor. Prod/shared/sensitive targets require dangerAck.
async function applyToInstances(
  actor: string,
  body: Record<string, unknown>,
  instanceIds: string[],
): Promise<Response> {
  const dangerAck = body.dangerAck === true;
  // Resolve the source clerkInstance from a stored config id, or take it directly.
  let clerkInstance = (body.clerkInstance as string | undefined) ?? undefined;
  if (body.configId) {
    const cfg = await getClerkConfigById(body.configId as string);
    if (!cfg) return bad("config not found", 404);
    clerkInstance = cfg.clerkInstance;
  }
  if (!clerkInstance) return bad("configId or clerkInstance required");
  if (instanceIds.length === 0) return bad("instanceIds must not be empty");

  const results: Array<{ instanceId: string; jobId?: string; error?: string }> = [];
  for (const id of instanceIds) {
    const target = await getInstance(id);
    if (!target) {
      results.push({ instanceId: id, error: "instance not found" });
      continue;
    }
    const danger = applyDanger(target, clerkInstance);
    if (danger && !dangerAck) {
      results.push({ instanceId: id, error: `refusing without dangerAck: ${danger}` });
      continue;
    }
    const res = await enqueueUpdate(id, { clerkInstance, dangerAck: dangerAck || undefined });
    if ("error" in res) results.push({ instanceId: id, error: res.error });
    else results.push({ instanceId: id, jobId: res.jobId });
  }
  const applied = results.filter((r) => r.jobId).length;
  await recordAudit(actor, "clerk.apply", instanceIds.join(","), `${clerkInstance} → ${applied}/${instanceIds.length} instance(s)`).catch(() => {});
  return ok({ results });
}
