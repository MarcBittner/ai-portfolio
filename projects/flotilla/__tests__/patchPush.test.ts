import { describe, it, expect, vi } from "vitest";
import {
  validatePatch,
  patchPushGuard,
  ephemeralBranchName,
  runPatchPush,
  PATCH_LIMITS,
  type PatchPushDeps,
} from "../lib/patchPush.ts";
import type { InstanceDoc } from "../lib/models/instances.ts";
import { PROD_CONVEX_DEPLOYMENT } from "../lib/provision.ts";
import type { StepResult } from "../lib/provision.ts";

// runPatchPush is pure over injected upstreams (mirrors lib/aiFixLoop.ts): we fake
// getInstance, the GitHub push, AND the provision, so no Mongo / GITHUB_TOKEN /
// real git / real provision is needed. These cover the validator, the scope
// guard, ephemeral-branch naming, and the apply→deploy happy/refusal paths.

function inst(over: Partial<InstanceDoc> = {}): InstanceDoc {
  const ts = 1_000;
  return {
    id: "inst_abc",
    idempotencyKey: "k",
    name: "staging-oppp5hyz",
    kind: "preview",
    branch: "staging",
    convexDeployment: "quaint-ferret-862",
    createdConvexDeployment: "quaint-ferret-862",
    vercelProject: "cover-preview-abc",
    status: "ready",
    health: "healthy",
    migrations: true,
    scrubPII: true,
    createdByTool: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

// A minimal well-formed unified diff (git style).
const GOOD_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

describe("validatePatch", () => {
  it("accepts a well-formed unified diff and counts files/hunks", () => {
    const v = validatePatch(GOOD_PATCH);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.stats.files).toBe(1);
      expect(v.stats.hunks).toBe(1);
    }
  });

  it("accepts a plain `diff -u` with no `diff --git` header (counts via +++)", () => {
    const plain = `--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-a\n+b\n`;
    const v = validatePatch(plain);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.stats.files).toBe(1);
  });

  it("rejects a non-string", () => {
    expect(validatePatch(123).ok).toBe(false);
    expect(validatePatch(null).ok).toBe(false);
  });

  it("rejects an empty / whitespace patch", () => {
    expect(validatePatch("").ok).toBe(false);
    expect(validatePatch("   \n  ").ok).toBe(false);
  });

  it("rejects text with no hunk header (not a unified diff)", () => {
    const v = validatePatch("just some prose\nnot a diff at all\n");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/hunk/);
  });

  it("rejects a git binary patch", () => {
    const bin = `diff --git a/logo.png b/logo.png\n--- a/logo.png\n+++ b/logo.png\n@@ -1 +1 @@\nGIT binary patch\n`;
    const v = validatePatch(bin);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/binary/);
  });

  it("rejects a `Binary files differ` marker", () => {
    const bin = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\nBinary files a/x and b/x differ\n`;
    expect(validatePatch(bin).ok).toBe(false);
  });

  it("rejects a NUL byte (binary content)", () => {
    const v = validatePatch(`--- a\n+++ b\n@@ -1 +1 @@\n-x\0y\n+z\n`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/NUL/);
  });

  it("rejects an over-size patch", () => {
    const huge = "x".repeat(PATCH_LIMITS.maxBytes + 1);
    const v = validatePatch(GOOD_PATCH + huge);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/too large/);
  });

  it("rejects too many files", () => {
    const v = validatePatch(GOOD_PATCH, { ...PATCH_LIMITS, maxFiles: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/too many files/);
  });
});

describe("patchPushGuard", () => {
  it("refuses a non-tool-created instance", () => {
    const g = patchPushGuard(inst({ createdByTool: false }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/tool-created/);
  });

  it("refuses a missing instance", () => {
    const g = patchPushGuard(null);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/not found/);
  });

  it("refuses the PRODUCTION Convex deployment", () => {
    const g = patchPushGuard(inst({ createdConvexDeployment: PROD_CONVEX_DEPLOYMENT, convexDeployment: PROD_CONVEX_DEPLOYMENT }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/PRODUCTION/);
  });

  it("refuses a shared Convex deployment", () => {
    // demo-staging-prod is the baked staging-prod shared deployment.
    const g = patchPushGuard(inst({ createdConvexDeployment: "demo-staging-prod", convexDeployment: "demo-staging-prod" }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/shared/);
  });

  it("refuses a protected/shared Vercel project", () => {
    const g = patchPushGuard(inst({ vercelProject: "production" }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/shared\/prod/);
  });

  it("accepts a clean tool-created preview", () => {
    expect(patchPushGuard(inst()).ok).toBe(true);
  });
});

describe("ephemeralBranchName", () => {
  it("derives a url-safe flotilla-patch/<slug>-<ts> branch", () => {
    const b = ephemeralBranchName(inst({ name: "My Preview!!" }), 100);
    expect(b).toMatch(/^flotilla-patch\/my-preview-[a-z0-9]+$/);
  });
});

// A fake provision outcome so runPatchPush can assert without a real deploy.
function outcome(over: { ok?: boolean; steps?: StepResult[]; url?: string } = {}) {
  return {
    ok: over.ok ?? true,
    steps: over.steps ?? ([{ name: "deploy-code", ok: true, detail: "deployed" }] as StepResult[]),
    url: over.url ?? "https://cover-preview-abc.vercel.app",
    vercelDeploymentId: "dep_123",
    createdByTool: true,
    masked: false,
  };
}

function deps(over: Partial<PatchPushDeps> = {}): PatchPushDeps {
  return {
    getInstance: async () => inst(),
    pushPatch: vi.fn(async (a) => ({ branch: a.branchName, baseSha: "base00", headSha: "head1234abcd", filesChanged: 1 })),
    provision: vi.fn(async () => outcome()) as PatchPushDeps["provision"],
    now: () => 100,
    ...over,
  };
}

describe("runPatchPush", () => {
  it("applies the patch to an ephemeral branch and redeploys that ref", async () => {
    const d = deps();
    const res = await runPatchPush("inst_abc", GOOD_PATCH, { filename: "fix.patch" }, d);
    expect(res.ok).toBe(true);
    expect(res.branch).toMatch(/^flotilla-patch\//);
    expect(res.url).toBe("https://cover-preview-abc.vercel.app");
    // The redeploy targets the ephemeral branch (not the base branch), code-only.
    const provArgs = (d.provision as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(provArgs.branch).toBe(res.branch);
    expect(provArgs.dimensions).toEqual(["code"]);
    expect(provArgs.target.createdByTool).toBe(true);
  });

  it("throws (and never pushes) when the scope guard refuses", async () => {
    const push = vi.fn();
    await expect(
      runPatchPush("inst_abc", GOOD_PATCH, {}, deps({ getInstance: async () => inst({ createdByTool: false }), pushPatch: push })),
    ).rejects.toThrow(/refused/);
    expect(push).not.toHaveBeenCalled();
  });

  it("throws (and never pushes) on an invalid patch", async () => {
    const push = vi.fn();
    await expect(runPatchPush("inst_abc", "not a diff", {}, deps({ pushPatch: push }))).rejects.toThrow(/invalid patch/);
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a failed redeploy without throwing", async () => {
    const d = deps({
      provision: (async () =>
        outcome({ ok: false, steps: [{ name: "deploy-code", ok: false, detail: "vercel 500" }] as StepResult[] })) as PatchPushDeps["provision"],
    });
    const res = await runPatchPush("inst_abc", GOOD_PATCH, {}, d);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/deploy-code/);
  });
});
