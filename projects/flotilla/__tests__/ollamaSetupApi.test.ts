import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Route-level gating + fallback for POST/GET /api/ai/ollama/setup (mirrors
// patchPushRoute.test.ts): hoisted mocks for auth + the models barrel + the
// ollamaSetup runner, so we assert the layered gates (auth → admin floor →
// allowlisted step) and the "not available here" fallback without Mongo or a real
// child process. The endpoint must NEVER run anything but an allowlisted step, and
// must be admin-gated (spawning on the server host is as sensitive as retargeting
// ollamaUrl in /api/config).

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;

vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));
vi.mock("@/lib/models", () => ({
  getConfigValues: async () => ({ aiModel: "" }),
  recordAudit: async () => {},
}));

// The runner + binary check are unit-tested separately; here we stub them to prove
// the ROUTE gates + shapes correctly, and record what step it forwarded.
const { runOllamaSetupStep, ollamaBinaryAvailable, resolveOllamaModel } = vi.hoisted(() => ({
  runOllamaSetupStep: vi.fn(
    async (
      step: string,
      model: string,
    ): Promise<{
      ok: boolean;
      code: "ran" | "not_available" | "failed";
      step: string;
      model: string;
      message: string;
      output?: string;
    }> => ({ ok: true, code: "ran", step, model, message: "ok" }),
  ),
  ollamaBinaryAvailable: vi.fn(async () => true),
  resolveOllamaModel: vi.fn(() => "llama3.1:8b"),
}));
vi.mock("@/lib/ollamaSetup", async (importOriginal) => {
  // Keep the real allowlist predicates (isOllamaSetupStep / ollamaSetupCommands) so
  // the route's zod refinement behaves exactly as in production; stub only the
  // side-effecting runner + probe.
  const actual = await importOriginal<typeof import("@/lib/ollamaSetup")>();
  return { ...actual, runOllamaSetupStep, ollamaBinaryAvailable, resolveOllamaModel };
});

import { POST, GET } from "@/app/api/ai/ollama/setup/route";

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/ai/ollama/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeEach(() => {
  principal = { kind: "clerk", id: "admin@example.com", role: "admin" };
  runOllamaSetupStep.mockClear();
  ollamaBinaryAvailable.mockClear();
  ollamaBinaryAvailable.mockResolvedValue(true);
});

describe("POST /api/ai/ollama/setup — gating", () => {
  it("401 when unauthenticated", async () => {
    principal = null;
    const { status } = await readJson(await POST(postReq({ step: "pull" })));
    expect(status).toBe(401);
    expect(runOllamaSetupStep).not.toHaveBeenCalled();
  });

  it("403 for a write principal (below the admin floor)", async () => {
    principal = { kind: "clerk", id: "w@example.com", role: "write" };
    const { status } = await readJson(await POST(postReq({ step: "pull" })));
    expect(status).toBe(403);
    expect(runOllamaSetupStep).not.toHaveBeenCalled();
  });

  it("403 for read-only", async () => {
    principal = { kind: "clerk", id: "ro@example.com", role: "read-only" };
    const { status } = await readJson(await POST(postReq({ step: "pull" })));
    expect(status).toBe(403);
  });
});

describe("POST /api/ai/ollama/setup — allowlist", () => {
  it("rejects a non-allowlisted step (400) without running anything", async () => {
    const { status } = await readJson(await POST(postReq({ step: "install" })));
    expect(status).toBe(400);
    expect(runOllamaSetupStep).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary command string (400)", async () => {
    const { status } = await readJson(await POST(postReq({ step: "rm -rf /" })));
    expect(status).toBe(400);
    expect(runOllamaSetupStep).not.toHaveBeenCalled();
  });

  it("rejects a missing step (400)", async () => {
    const { status } = await readJson(await POST(postReq({})));
    expect(status).toBe(400);
    expect(runOllamaSetupStep).not.toHaveBeenCalled();
  });

  it("admin + allowlisted step ⇒ forwards to the runner with the resolved model", async () => {
    const { status, json } = await readJson(await POST(postReq({ step: "pull" })));
    expect(status).toBe(200);
    expect(runOllamaSetupStep).toHaveBeenCalledWith("pull", "llama3.1:8b");
    expect(json.ok).toBe(true);
    expect(json.code).toBe("ran");
  });
});

describe("POST /api/ai/ollama/setup — not-available fallback", () => {
  it("returns a clean not_available result (200, no crash) when the host has no binary", async () => {
    runOllamaSetupStep.mockResolvedValueOnce({
      ok: false,
      code: "not_available",
      step: "pull",
      model: "llama3.1:8b",
      message: "Ollama is not installed on the server host — run the commands locally.",
    });
    const { status, json } = await readJson(await POST(postReq({ step: "pull" })));
    expect(status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("not_available");
    expect(String(json.message)).toMatch(/locally|not installed/i);
  });
});

describe("GET /api/ai/ollama/setup — capability probe", () => {
  it("read-only may query it; reports serverCanRun + model + copy-able commands", async () => {
    principal = { kind: "clerk", id: "ro@example.com", role: "read-only" };
    ollamaBinaryAvailable.mockResolvedValue(false);
    const { status, json } = await readJson(await GET());
    expect(status).toBe(200);
    expect(json.serverCanRun).toBe(false);
    expect(json.model).toBe("llama3.1:8b");
    const commands = json.commands as Record<string, string>;
    expect(commands.install).toContain("ollama.com/install.sh");
    expect(commands.pull).toBe("ollama pull llama3.1:8b");
  });

  it("401 when unauthenticated", async () => {
    principal = null;
    const { status } = await readJson(await GET());
    expect(status).toBe(401);
  });
});
