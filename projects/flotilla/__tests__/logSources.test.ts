import { describe, it, expect } from "vitest";
import {
  fromSystemLog,
  fromAudit,
  fromVercel,
  mergeEntries,
  filterBySource,
  filterByInstance,
  buildLinks,
  type UnifiedEntry,
} from "@/lib/logSources";
import type { LogDoc } from "@/lib/models/logs";
import type { AuditDoc } from "@/lib/models/audit";
import type { VercelLogEntry } from "@/lib/clients/vercel";

// logSources is pure over its inputs — no Mongo/Vercel tokens needed. We build
// fixtures for each feed and assert the normalize → merge → filter → link fold.

function sysLog(over: Partial<LogDoc> = {}): LogDoc {
  return {
    seq: 1,
    ts: 1_000,
    source: "orchestrator",
    level: "info",
    msg: "provision start",
    createdAt: 1_000,
    ...over,
  };
}
function audit(over: Partial<AuditDoc> = {}): AuditDoc {
  return {
    id: "aud_1",
    seq: 1,
    ts: 2_000,
    actor: "marc@example.com",
    action: "instance.launch",
    target: "inst_abc123",
    ...over,
  };
}
function vlog(over: Partial<VercelLogEntry> = {}): VercelLogEntry {
  return { ts: 3_000, level: "info", type: "stdout", text: "Build completed", ...over };
}

describe("normalizers", () => {
  it("system log collapses to source:system and tags the emitting client", () => {
    const e = fromSystemLog(sysLog({ source: "vercel", msg: "deploy", instanceId: "inst_x" }));
    expect(e.source).toBe("system");
    expect(e.msg).toBe("[vercel] deploy");
    expect(e.instanceId).toBe("inst_x");
  });

  it("system log from the orchestrator is not tagged (that emitter IS us)", () => {
    expect(fromSystemLog(sysLog({ source: "orchestrator", msg: "step 1" })).msg).toBe("step 1");
  });

  it("system log normalizes an unknown level to info", () => {
    expect(fromSystemLog(sysLog({ level: "debug" as LogDoc["level"] })).level).toBe("info");
  });

  it("audit carries actor + derives instanceId from an inst_ target", () => {
    const e = fromAudit(audit({ detail: "branch=main" }));
    expect(e.source).toBe("audit");
    expect(e.actor).toBe("marc@example.com");
    expect(e.instanceId).toBe("inst_abc123");
    expect(e.msg).toBe("instance.launch · inst_abc123 — branch=main");
  });

  it("audit with a non-instance target has no instanceId", () => {
    const e = fromAudit(audit({ action: "backup.delete", target: "bak_99" }));
    expect(e.instanceId).toBeUndefined();
    expect(e.msg).toBe("backup.delete · bak_99");
  });

  it("vercel maps level + prefixes non-stdout types + carries the scoped instanceId", () => {
    const e = fromVercel(vlog({ level: "error", type: "stderr", text: "boom" }), "inst_z");
    expect(e.source).toBe("vercel");
    expect(e.level).toBe("error");
    expect(e.msg).toBe("[stderr] boom");
    expect(e.instanceId).toBe("inst_z");
  });
});

describe("mergeEntries", () => {
  it("orders newest-first across all feeds", () => {
    const merged = mergeEntries(
      [fromSystemLog(sysLog({ ts: 1_000 }))],
      [fromAudit(audit({ ts: 2_000 }))],
      [fromVercel(vlog({ ts: 3_000 }), "inst_z")],
    );
    expect(merged.map((e) => e.source)).toEqual(["vercel", "audit", "system"]);
  });

  it("breaks ts ties stably (input order preserved)", () => {
    const a: UnifiedEntry = { ts: 5, source: "system", level: "info", msg: "a" };
    const b: UnifiedEntry = { ts: 5, source: "audit", level: "info", msg: "b" };
    expect(mergeEntries([a], [b]).map((e) => e.msg)).toEqual(["a", "b"]);
  });
});

describe("filters", () => {
  const entries = mergeEntries(
    [fromSystemLog(sysLog({ ts: 1_000, instanceId: "inst_1" }))],
    [fromAudit(audit({ ts: 2_000, target: "inst_2" }))],
    [fromVercel(vlog({ ts: 3_000 }), "inst_1")],
  );

  it("filterBySource keeps only the requested source (undefined = all)", () => {
    expect(filterBySource(entries, "vercel").map((e) => e.source)).toEqual(["vercel"]);
    expect(filterBySource(entries, undefined)).toHaveLength(3);
  });

  it("filterByInstance keeps only matching instanceId (undefined = all)", () => {
    const only1 = filterByInstance(entries, "inst_1");
    expect(only1).toHaveLength(2);
    expect(only1.every((e) => e.instanceId === "inst_1")).toBe(true);
    expect(filterByInstance(entries, undefined)).toHaveLength(3);
  });
});

describe("buildLinks", () => {
  it("builds a Convex deployment logs deep link + Clerk dashboard link", () => {
    const links = buildLinks({ convexDeployment: "quaint-ferret-862", clerkInstance: "stirred-leech-68" });
    expect(links.convex).toBe("https://dashboard.convex.dev/d/quaint-ferret-862/logs");
    expect(links.clerk).toBe("https://dashboard.clerk.com/");
  });

  it("falls back to createdConvexDeployment when convexDeployment is absent", () => {
    expect(buildLinks({ createdConvexDeployment: "fresh-otter-1" }).convex).toBe(
      "https://dashboard.convex.dev/d/fresh-otter-1/logs",
    );
  });

  it("omits links that cannot be built (no deployment / no clerk / null)", () => {
    expect(buildLinks({ clerkInstance: "abc" }).convex).toBeUndefined();
    expect(buildLinks({ convexDeployment: "d1" }).clerk).toBeUndefined();
    expect(buildLinks(null)).toEqual({});
  });
});
