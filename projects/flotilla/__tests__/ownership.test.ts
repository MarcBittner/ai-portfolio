import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Ownership registry (Track D). Exercises the model (field defaults + back-compat),
// capture-on-create through the create/enqueue path, the owner/team filter, and the
// write-gated, audited reassign route — all against the in-memory Mongo so the
// owner/audit round-trip is real (no Atlas).
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
      config: "config",
      backups: "backups",
    },
    BACKUP_BUCKET: "backup_files",
  };
});

// A mutable principal drives the route's withOperator gate + the capture-on-create
// attribution. Mocking "@/lib/auth" intercepts the same resolved module the route's
// withOperator imports.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { resetStore } from "./helpers/fakeMongo";
import {
  createInstance,
  listInstances,
  getInstance,
  updateInstanceOwner,
  listAudit,
} from "@/lib/models";
import { GET as instancesGET, POST as instancesPOST } from "@/app/api/instances/route";
import { PATCH as instancePATCH } from "@/app/api/instances/[id]/route";

function asRole(role: Role, id = `${role}@example.com`) {
  principal = { kind: "clerk", id, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function jsonReq(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetStore();
  principal = null;
});

describe("model: owner field defaults + back-compat", () => {
  it("a create with no owner fields leaves them all undefined (legacy-shaped row is valid)", async () => {
    const inst = await createInstance({ branch: "feature/x" });
    expect(inst.ownerUserId).toBeUndefined();
    expect(inst.ownerEmail).toBeUndefined();
    expect(inst.ownerName).toBeUndefined();
    expect(inst.team).toBeUndefined();
    expect(inst.owner).toBeUndefined();
    // The row still round-trips through the store unchanged.
    expect((await getInstance(inst.id))?.branch).toBe("feature/x");
  });

  it("persists structured owner + team when supplied", async () => {
    const inst = await createInstance({
      branch: "feature/y",
      ownerEmail: "tony@example.com",
      ownerUserId: "tony@example.com",
      ownerName: "Tony",
      team: "platform",
    });
    const saved = await getInstance(inst.id);
    expect(saved?.ownerEmail).toBe("tony@example.com");
    expect(saved?.ownerName).toBe("Tony");
    expect(saved?.team).toBe("platform");
  });
});

describe("capture-on-create: POST /api/instances stamps the acting principal", () => {
  it("attributes ownerEmail/ownerUserId to the caller when no owner is provided", async () => {
    asRole("write", "nick@example.com");
    const { status, json } = await readJson(
      await instancesPOST(jsonReq("http://localhost/api/instances", "POST", { branch: "feature/a" })),
    );
    expect(status).toBe(200);
    const inst = await getInstance(json.instanceId as string);
    expect(inst?.ownerEmail).toBe("nick@example.com");
    expect(inst?.ownerUserId).toBe("nick@example.com");
    expect(inst?.owner).toBe("nick@example.com"); // legacy field stays in step
  });

  it("does NOT overwrite an explicitly-provided owner (provision-on-behalf-of)", async () => {
    asRole("write", "nick@example.com");
    const { json } = await readJson(
      await instancesPOST(
        jsonReq("http://localhost/api/instances", "POST", {
          branch: "feature/b",
          ownerEmail: "dana@example.com",
          ownerName: "Dana",
          team: "data",
        }),
      ),
    );
    const inst = await getInstance(json.instanceId as string);
    expect(inst?.ownerEmail).toBe("dana@example.com");
    expect(inst?.ownerName).toBe("Dana");
    expect(inst?.team).toBe("data");
    // ownerUserId still defaults to the acting principal (the operator who ran it).
    expect(inst?.ownerUserId).toBe("nick@example.com");
  });
});

describe("filter: listInstances + GET ?owner= / ?team=", () => {
  beforeEach(async () => {
    await createInstance({ branch: "b1", ownerEmail: "a@example.com", team: "platform", idempotencyKey: "k1" });
    await createInstance({ branch: "b2", ownerEmail: "a@example.com", team: "data", idempotencyKey: "k2" });
    await createInstance({ branch: "b3", ownerEmail: "b@example.com", team: "platform", idempotencyKey: "k3" });
    await createInstance({ branch: "b4", idempotencyKey: "k4" }); // owner-less legacy row
  });

  it("model filters by owner (ownerEmail) and by team", async () => {
    expect((await listInstances({ owner: "a@example.com" })).length).toBe(2);
    expect((await listInstances({ team: "platform" })).length).toBe(2);
    expect((await listInstances({ owner: "a@example.com", team: "platform" })).length).toBe(1);
    expect((await listInstances()).length).toBe(4); // no filter = everything, incl. legacy
  });

  it("GET /api/instances honors ?owner= and ?team=", async () => {
    asRole("read-only");
    const owned = await readJson(await instancesGET(new Request("http://localhost/api/instances?owner=a@example.com")));
    expect((owned.json.instances as unknown[]).length).toBe(2);
    const team = await readJson(await instancesGET(new Request("http://localhost/api/instances?team=platform")));
    expect((team.json.instances as unknown[]).length).toBe(2);
    const all = await readJson(await instancesGET(new Request("http://localhost/api/instances")));
    expect((all.json.instances as unknown[]).length).toBe(4);
  });
});

describe("reassign: PATCH action=reassign-owner (write-gated + audited)", () => {
  async function seed() {
    const inst = await createInstance({ branch: "feature/x", ownerEmail: "old@example.com", team: "platform" });
    return inst.id;
  }

  it("reassigns owner + team and writes an audit row with before→after", async () => {
    const id = await seed();
    asRole("write", "op@example.com");
    const { status, json } = await readJson(
      await instancePATCH(
        jsonReq(`http://localhost/api/instances/${id}`, "PATCH", {
          action: "reassign-owner",
          ownerEmail: "new@example.com",
          team: "data",
        }),
        ctx(id),
      ),
    );
    expect(status).toBe(200);
    expect((json.instance as { ownerEmail: string }).ownerEmail).toBe("new@example.com");

    const saved = await getInstance(id);
    expect(saved?.ownerEmail).toBe("new@example.com");
    expect(saved?.team).toBe("data");
    expect(saved?.owner).toBe("new@example.com"); // legacy display kept in step

    const audit = await listAudit();
    const row = audit.find((a) => a.action === "instance.owner.reassign");
    expect(row).toBeTruthy();
    expect(row?.actor).toBe("op@example.com");
    expect(row?.target).toBe(id);
    expect(row?.detail).toContain("old@example.com");
    expect(row?.detail).toContain("new@example.com");
  });

  it("a read-only principal is blocked from reassigning (403, no audit)", async () => {
    const id = await seed();
    asRole("read-only");
    const { status } = await readJson(
      await instancePATCH(
        jsonReq(`http://localhost/api/instances/${id}`, "PATCH", { action: "reassign-owner", team: "data" }),
        ctx(id),
      ),
    );
    expect(status).toBe(403);
    expect((await getInstance(id))?.team).toBe("platform"); // unchanged
    const audit = await listAudit();
    expect(audit.find((a) => a.action === "instance.owner.reassign")).toBeUndefined();
  });

  it("an empty reassign (no fields) is rejected (400)", async () => {
    const id = await seed();
    asRole("write");
    const { status } = await readJson(
      await instancePATCH(jsonReq(`http://localhost/api/instances/${id}`, "PATCH", { action: "reassign-owner" }), ctx(id)),
    );
    expect(status).toBe(400);
  });

  it("a partial reassign changes only the given field (team), owner untouched", async () => {
    const id = await seed();
    const updated = await updateInstanceOwner(id, { team: "infra" });
    expect(updated?.team).toBe("infra");
    expect(updated?.ownerEmail).toBe("old@example.com"); // unchanged
  });
});
