import { describe, it, expect, vi, beforeEach } from "vitest";

// Same in-memory Mongo fake used by models.test — include the new collections.
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
      backups: "backups",
      audit: "audit",
    },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  createInstance,
  updateInstance,
  getInstance,
  listExpiredInstances,
  deleteInstanceClerkRecords,
  getInstanceByIdOrName,
  upsertManagedUser,
  upsertClerkConfig,
  listManagedUsers,
  recordAudit,
  listAudit,
} from "@/lib/models";

beforeEach(() => resetStore());

describe("instance TTL", () => {
  it("stamps expiresAt only when a ttlHours is requested", async () => {
    const withTtl = await createInstance({ branch: "b", ttlHours: 4, idempotencyKey: "a" });
    expect(withTtl.ttlHours).toBe(4);
    expect(withTtl.expiresAt).toBeGreaterThan(Date.now());

    const noTtl = await createInstance({ branch: "b2", idempotencyKey: "b" });
    expect(noTtl.ttlHours).toBeUndefined();
    expect(noTtl.expiresAt).toBeUndefined();
  });

  it("persists owner", async () => {
    const i = await createInstance({ branch: "b", owner: "marc@x.com", idempotencyKey: "k" });
    expect(i.owner).toBe("marc@x.com");
  });
});

describe("listExpiredInstances", () => {
  it("returns only tool-created, ready instances past expiry", async () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 3600_000;

    const a = await createInstance({ branch: "expired", idempotencyKey: "a" });
    await updateInstance(a.id, { createdByTool: true, status: "ready", expiresAt: past });

    const b = await createInstance({ branch: "fresh", idempotencyKey: "b" });
    await updateInstance(b.id, { createdByTool: true, status: "ready", expiresAt: future });

    const c = await createInstance({ branch: "no-ttl", idempotencyKey: "c" });
    await updateInstance(c.id, { createdByTool: true, status: "ready" }); // no expiresAt

    const d = await createInstance({ branch: "not-tool", idempotencyKey: "d" });
    await updateInstance(d.id, { createdByTool: false, status: "ready", expiresAt: past });

    const e = await createInstance({ branch: "provisioning", idempotencyKey: "e" });
    await updateInstance(e.id, { createdByTool: true, status: "provisioning", expiresAt: past });

    const expired = await listExpiredInstances();
    expect(expired.map((x) => x.id)).toEqual([a.id]);
  });
});

describe("teardown record cleanup", () => {
  it("removes managed users + clerk config for an instance only", async () => {
    await upsertManagedUser({ instanceId: "i1", email: "a@b.com" });
    await upsertManagedUser({ instanceId: "i1", email: "c@d.com" });
    await upsertManagedUser({ instanceId: "i2", email: "keep@me.com" });
    await upsertClerkConfig({ instanceId: "i1", clerkInstance: "clerk-1", config: { a: 1 } });

    const removed = await deleteInstanceClerkRecords("i1");
    expect(removed).toBe(3); // 2 users + 1 config
    expect(await listManagedUsers("i1")).toHaveLength(0);
    expect(await listManagedUsers("i2")).toHaveLength(1);
  });
});

describe("getInstanceByIdOrName", () => {
  it("resolves by id and by name", async () => {
    const i = await createInstance({ name: "staging-xyz", branch: "b", idempotencyKey: "k" });
    expect((await getInstanceByIdOrName(i.id))?.id).toBe(i.id);
    expect((await getInstanceByIdOrName("staging-xyz"))?.id).toBe(i.id);
    expect(await getInstanceByIdOrName("nope")).toBeNull();
    void getInstance;
  });
});

describe("audit trail", () => {
  it("records and lists most-recent-first", async () => {
    await recordAudit("marc@x.com", "instance.launch", "inst_1", "branch=main");
    await recordAudit("tony@x.com", "backup.delete", "bkp_2");
    const entries = await listAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0].actor).toBe("tony@x.com"); // newest first
    expect(entries[0].action).toBe("backup.delete");
    expect(entries[1].detail).toBe("branch=main");
  });
});
