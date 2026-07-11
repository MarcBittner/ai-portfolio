import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Mongo so the model + route logic runs without Atlas, and a fixed
// operator principal so withOperator lets the POST route through (no Clerk keys /
// break-glass cookie in this worktree). No network anywhere: the apply flow's only
// side effect is enqueueUpdate, which just persists a queued job into fakeMongo
// (the inline worker is gated behind FLOTILLA_INLINE_WORKER=1, off here).
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: {
      instances: "instances",
      templates: "templates",
      jobs: "jobs",
      logs: "logs",
      clerkConfigs: "clerkConfigs",
      managedUsers: "managedUsers",
      audit: "audit",
      backups: "backups",
    },
    BACKUP_BUCKET: "backup_files",
  };
});

// break-glass session = super-admin (docs/spec/DESIGN-rbac.md) — a role is now
// required on the Principal so withOperator's write gate on POST /api/clerk lets
// the apply flow through.
vi.mock("@/lib/auth", () => ({
  getPrincipal: async () => ({ kind: "breakglass", id: "op@example.com", role: "super-admin" }),
}));

import { resetStore } from "./helpers/fakeMongo";
import {
  saveClerkTemplate,
  listClerkTemplates,
  listClerkConfigs,
  getClerkConfigById,
  createInstance,
} from "@/lib/models";
import { getJob } from "@/lib/models";
import { POST } from "@/app/api/clerk/route";

beforeEach(() => {
  resetStore();
  // Generic sensitive Clerk hosts (env-driven; nothing org-specific hardcoded).
  process.env.SENSITIVE_CLERK_INSTANCES = "clerk.prod.example.com, clerk.staging.example.com";
});

// Small helper: POST a JSON body to the real /api/clerk route handler.
async function post(body: Record<string, unknown>) {
  const req = new Request("http://localhost/api/clerk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("saveClerkTemplate", () => {
  it("persists a named template row (template:true, self-referential instanceId)", async () => {
    const doc = await saveClerkTemplate({
      name: "Dev auth",
      clerkInstance: "clerk.dev.example.com",
      params: { label: "Dev", passwordless: true },
      createdBy: "op@example.com",
    });
    expect(doc.template).toBe(true);
    expect(doc.name).toBe("Dev auth");
    expect(doc.clerkInstance).toBe("clerk.dev.example.com");
    // instanceId is the row's own id so it can never shadow a live instance's config.
    expect(doc.instanceId).toBe(doc.id);
    expect(doc.params).toEqual({ label: "Dev", passwordless: true });
    expect(doc.createdBy).toBe("op@example.com");
  });

  it("defaults params to { clerkInstance } when none are supplied", async () => {
    const doc = await saveClerkTemplate({ name: "Bare", clerkInstance: "clerk.bare" });
    expect(doc.params).toEqual({ clerkInstance: "clerk.bare" });
  });

  it("each save is an insert (never an upsert) so two templates never clobber", async () => {
    const a = await saveClerkTemplate({ name: "One", clerkInstance: "clerk.one" });
    const b = await saveClerkTemplate({ name: "Two", clerkInstance: "clerk.one" });
    expect(a.id).not.toBe(b.id);
    expect((await listClerkTemplates()).length).toBe(2);
  });

  it("rejects an empty name (Zod min(1))", async () => {
    await expect(saveClerkTemplate({ name: "", clerkInstance: "clerk.x" })).rejects.toThrow();
  });
});

describe("listClerkTemplates", () => {
  it("returns only template rows, newest-first, excluding per-instance drift rows", async () => {
    // A per-instance drift row is NOT a template and must not appear here.
    const { upsertClerkConfig } = await import("@/lib/models");
    await upsertClerkConfig({ instanceId: "inst_live", clerkInstance: "clerk.live", config: { a: 1 } });
    const older = await saveClerkTemplate({ name: "Older", clerkInstance: "clerk.a" });
    // Force a strictly-later updatedAt so the sort is deterministic.
    const newer = await saveClerkTemplate({ name: "Newer", clerkInstance: "clerk.b" });

    const templates = await listClerkTemplates();
    expect(templates.every((t) => t.template === true)).toBe(true);
    expect(templates.map((t) => t.name)).not.toContain(undefined);
    // Both templates present; the live drift row is excluded.
    expect(templates.map((t) => t.id).sort()).toEqual([older.id, newer.id].sort());
    // The full list DOES include the live row (2 templates + 1 drift row).
    expect((await listClerkConfigs()).length).toBe(3);
  });
});

describe("apply-payload shaping (POST { action: 'apply', configId, instanceIds })", () => {
  it("resolves the config's clerkInstance and enqueues a clerk-dimension update per target", async () => {
    const tpl = await saveClerkTemplate({ name: "Apply me", clerkInstance: "clerk.newdev.example.com" });
    const a = await createInstance({ branch: "feature/a", clerkInstance: "clerk.old-a" });
    const b = await createInstance({ branch: "feature/b", clerkInstance: "clerk.old-b" });

    const { status, json } = await post({ action: "apply", configId: tpl.id, instanceIds: [a.id, b.id] });
    expect(status).toBe(200);
    const results = json.results as Array<{ instanceId: string; jobId?: string; error?: string }>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.jobId && !r.error)).toBe(true);

    // The shaped payload: each enqueued job re-provisions ONLY the clerk dimension,
    // carrying the config's clerkInstance (resolved from configId, not from args).
    for (const r of results) {
      const job = await getJob(r.jobId!);
      expect(job?.type).toBe("update");
      expect(job?.opts.dimensions).toEqual(["clerk"]);
      expect(job?.opts.clerkInstance).toBe("clerk.newdev.example.com");
    }
  });

  it("accepts a raw clerkInstance (no stored config) and shapes the same payload", async () => {
    const a = await createInstance({ branch: "feature/c", clerkInstance: "clerk.old-c" });
    const { json } = await post({ action: "apply", clerkInstance: "clerk.raw", instanceIds: [a.id] });
    const results = json.results as Array<{ jobId?: string }>;
    const job = await getJob(results[0].jobId!);
    expect(job?.opts.clerkInstance).toBe("clerk.raw");
    expect(job?.opts.dimensions).toEqual(["clerk"]);
  });

  it("refuses a sensitive/prod target without dangerAck, then applies WITH it", async () => {
    const tpl = await saveClerkTemplate({ name: "To prod-ish", clerkInstance: "clerk.newdev" });
    // Target currently sits on a production Clerk instance → danger-gated.
    const prod = await createInstance({ branch: "feature/p", clerkInstance: "clerk.prod.example.com" });

    const refused = await post({ action: "apply", configId: tpl.id, instanceIds: [prod.id] });
    const refusedResults = refused.json.results as Array<{ error?: string; jobId?: string }>;
    expect(refusedResults[0].jobId).toBeUndefined();
    expect(refusedResults[0].error).toMatch(/refusing without dangerAck/);

    const acked = await post({ action: "apply", configId: tpl.id, instanceIds: [prod.id], dangerAck: true });
    const ackedResults = acked.json.results as Array<{ error?: string; jobId?: string }>;
    expect(ackedResults[0].jobId).toBeTruthy();
    const job = await getJob(ackedResults[0].jobId!);
    expect(job?.opts.dangerAck).toBe(true);
    expect(job?.opts.clerkInstance).toBe("clerk.newdev");
  });

  it("reports per-target errors without failing the batch (unknown instance)", async () => {
    const ok = await createInstance({ branch: "feature/ok", clerkInstance: "clerk.old" });
    const { json } = await post({
      action: "apply",
      clerkInstance: "clerk.applied",
      instanceIds: [ok.id, "inst_missing"],
    });
    const results = json.results as Array<{ instanceId: string; jobId?: string; error?: string }>;
    expect(results.find((r) => r.instanceId === ok.id)?.jobId).toBeTruthy();
    expect(results.find((r) => r.instanceId === "inst_missing")?.error).toBe("instance not found");
  });

  it("save-template action persists via the route and is round-trippable by id", async () => {
    const { status, json } = await post({
      action: "save-template",
      name: "Via route",
      clerkInstance: "clerk.route",
      params: { label: "R" },
    });
    expect(status).toBe(200);
    const cfg = json.config as { id: string; createdBy?: string };
    expect(cfg.id).toBeTruthy();
    // createdBy comes from the authenticated principal, never the request body.
    expect(cfg.createdBy).toBe("op@example.com");
    const back = await getClerkConfigById(cfg.id);
    expect(back?.clerkInstance).toBe("clerk.route");
    expect(back?.template).toBe(true);
  });
});
