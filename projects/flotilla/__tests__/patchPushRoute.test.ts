import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Route-level gating for the patch-push endpoint (mirrors handlerAuthOrder.test.ts):
// hoisted mocks for auth + the models barrel + the jobs enqueue, so we can assert
// the layered gates (auth → flag → github token → guard) without Mongo or git.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
let flags = { patchPush: true };
let instance: { id: string; name: string; createdByTool?: boolean } | null = null;

vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));
vi.mock("@/lib/models", () => ({
  getInstance: async () => instance,
  getFeatureFlags: async () => flags,
  recordAudit: async () => {},
}));
vi.mock("@/lib/clients/github", () => ({ githubPushConfigured: () => true }));
const { enqueuePatchPush } = vi.hoisted(() => ({
  enqueuePatchPush: vi.fn(async () => ({ jobId: "job_1", instanceId: "i1" })),
}));
vi.mock("@/lib/jobs", () => ({ enqueuePatchPush }));

import { POST } from "@/app/api/instances/[id]/patch-push/route";

const GOOD_PATCH = `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/instances/i1/patch-push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "i1" }) };

beforeEach(() => {
  principal = { kind: "clerk", id: "op@example.com", role: "write" };
  flags = { patchPush: true };
  instance = { id: "i1", name: "staging-x", createdByTool: true };
  enqueuePatchPush.mockClear();
});

describe("POST /api/instances/[id]/patch-push — layered gates", () => {
  it("401 when unauthenticated (before any flag/shape feedback)", async () => {
    principal = null;
    const res = await POST(jsonReq({ diff: GOOD_PATCH }), ctx);
    expect(res.status).toBe(401);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("403 for a read-only principal (below the write floor)", async () => {
    principal = { kind: "clerk", id: "ro@example.com", role: "read-only" };
    const res = await POST(jsonReq({ diff: GOOD_PATCH }), ctx);
    expect(res.status).toBe(403);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("403 when the patchPush feature flag is off", async () => {
    flags = { patchPush: false };
    const res = await POST(jsonReq({ diff: GOOD_PATCH }), ctx);
    expect(res.status).toBe(403);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("404 when the instance does not exist (guard)", async () => {
    instance = null;
    const res = await POST(jsonReq({ diff: GOOD_PATCH }), ctx);
    expect(res.status).toBe(404);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("409 for a non-tool-created instance (guard)", async () => {
    instance = { id: "i1", name: "staging-x", createdByTool: false };
    const res = await POST(jsonReq({ diff: GOOD_PATCH }), ctx);
    expect(res.status).toBe(409);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("400 for a malformed patch", async () => {
    const res = await POST(jsonReq({ diff: "not a diff" }), ctx);
    expect(res.status).toBe(400);
    expect(enqueuePatchPush).not.toHaveBeenCalled();
  });

  it("enqueues and returns {jobId} for a valid patch", async () => {
    const res = await POST(jsonReq({ diff: GOOD_PATCH, filename: "fix.patch" }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId?: string };
    expect(body.jobId).toBe("job_1");
    expect(enqueuePatchPush).toHaveBeenCalledOnce();
  });
});
