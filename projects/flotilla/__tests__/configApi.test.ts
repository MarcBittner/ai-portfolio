import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Fix E — the config PUT floor stays "write", but changing RESTRICTED keys
// (notifyWebhookUrl, ollamaUrl, or any feature flag) additionally requires admin.
// In-memory Mongo so the singleton upsert + audit write run without Atlas.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { config: "config", audit: "audit", configHistory: "configHistory" },
  };
});

// A mutable principal so each test drives withOperator with a chosen role.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { resetStore } from "./helpers/fakeMongo";
import { __resetConfigCache } from "@/lib/models";
import { PUT, GET } from "@/app/api/config/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function put(body: Record<string, unknown>) {
  return new Request("http://localhost/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStore();
  __resetConfigCache();
  principal = null;
});

describe("PUT /api/config — restricted-key admin gate (Fix E)", () => {
  it("a WRITE operator editing only ordinary defaults → 200", async () => {
    asRole("write");
    const { status } = await readJson(await PUT(put({ maskByDefault: false })));
    expect(status).toBe(200);
  });

  it("a WRITE operator setting notifyWebhookUrl → 403", async () => {
    asRole("write");
    const { status, json } = await readJson(await PUT(put({ notifyWebhookUrl: "https://hooks.slack.com/services/x" })));
    expect(status).toBe(403);
    expect(String(json.error)).toContain("notifyWebhookUrl");
  });

  it("a WRITE operator setting ollamaUrl → 403", async () => {
    asRole("write");
    const { status, json } = await readJson(await PUT(put({ ollamaUrl: "http://evil.internal:11434" })));
    expect(status).toBe(403);
    expect(String(json.error)).toContain("ollamaUrl");
  });

  it("a WRITE operator toggling a feature flag → 403", async () => {
    asRole("write");
    const { status, json } = await readJson(await PUT(put({ features: { notifications: true } })));
    expect(status).toBe(403);
    expect(String(json.error)).toContain("features.notifications");
  });

  it("an ADMIN setting notifyWebhookUrl → 200", async () => {
    asRole("admin");
    const { status, json } = await readJson(await PUT(put({ notifyWebhookUrl: "https://hooks.slack.com/services/x" })));
    expect(status).toBe(200);
    // Persisted (masked on read-back — host only, never the token path).
    expect(String((json.config as Record<string, unknown>).notifyWebhookUrl)).toContain("hooks.slack.com");
  });

  it("an ADMIN toggling a feature flag → 200", async () => {
    asRole("admin");
    const { status, json } = await readJson(await PUT(put({ features: { notifications: true } })));
    expect(status).toBe(200);
    expect((json.features as Record<string, boolean>).notifications).toBe(true);
  });

  it("a READ-ONLY principal is blocked by the write floor → 403", async () => {
    asRole("read-only");
    const { status } = await readJson(await PUT(put({ maskByDefault: false })));
    expect(status).toBe(403);
  });
});

describe("PUT /api/config — schedule windows + history (Flag/rollout UX)", () => {
  it("a WRITE operator setting a featureSchedules window → 403 (admin-gated)", async () => {
    asRole("write");
    const { status, json } = await readJson(
      await PUT(put({ featureSchedules: { costEstimates: { value: true, expiresAt: 2_000_000_000_000 } } })),
    );
    expect(status).toBe(403);
    expect(String(json.error)).toContain("featureSchedules.costEstimates");
  });

  it("an ADMIN setting a schedule window → 200, echoed in featureHints", async () => {
    asRole("admin");
    const { status, json } = await readJson(
      await PUT(put({ featureSchedules: { costEstimates: { value: true, activateAt: 2_000_000_000_000 } } })),
    );
    expect(status).toBe(200);
    const meta = json.meta as Record<string, unknown>;
    const hints = meta.featureHints as Record<string, { schedule?: { activateAt?: number } }>;
    expect(hints.costEstimates?.schedule?.activateAt).toBe(2_000_000_000_000);
  });

  it("a reason is recorded and surfaced in GET history", async () => {
    asRole("admin");
    await readJson(await PUT(put({ features: { costEstimates: true }, reason: "Q3 rollout" })));
    const { json } = await readJson(await GET());
    const meta = json.meta as Record<string, unknown>;
    const history = meta.history as { reason?: string; entries: { key: string }[] }[];
    expect(history[0].reason).toBe("Q3 rollout");
    expect(history[0].entries.some((e) => e.key === "features.costEstimates")).toBe(true);
  });

  it("GET returns staleFlags for a redundant override", async () => {
    asRole("admin");
    await readJson(await PUT(put({ features: { costEstimates: false } }))); // default is false → redundant
    const { json } = await readJson(await GET());
    const meta = json.meta as Record<string, unknown>;
    const stale = meta.staleFlags as { key: string; redundant: boolean }[];
    expect(stale.some((s) => s.key === "costEstimates" && s.redundant)).toBe(true);
  });
});
