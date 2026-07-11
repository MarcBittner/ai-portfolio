import { describe, it, expect, vi } from "vitest";
import { draftMonitor, type MonitorDraftDeps } from "../lib/monitoring/aiDraft.ts";
import { validateMonitorCreate } from "../lib/monitoring/validate.ts";

// draftMonitor is pure over injected upstreams (mirrors lib/aiTriage.ts): we fake
// anthropicConfigured, the forced Anthropic tool call, and the metric facets reader,
// so no ANTHROPIC_API_KEY, no Mongo, no metric store is needed. These cover: a NL
// request → a valid closed-registry draft; the honest-abstain on an unsupported
// request; an invalid draft rejected by the same create validator; degrade-when-not-
// configured; and that the draft round-trips through validateMonitorCreate.

// A raw tool payload the fake model "returns" from draft_monitor.
type RawDraft = Record<string, unknown>;

function deps(over: {
  configured?: boolean;
  raw?: RawDraft;
  callSpy?: ReturnType<typeof vi.fn>;
  facets?: MonitorDraftDeps["facets"];
}): MonitorDraftDeps {
  const callTool = over.callSpy ?? vi.fn(async () => over.raw as unknown);
  return {
    anthropicConfigured: () => over.configured ?? true,
    callTool: callTool as MonitorDraftDeps["callTool"],
    // Default: no metric grounding data (empty facets → no false warnings).
    facets: over.facets ?? (async () => ({ rows: [] })),
    model: "claude-sonnet-4-6",
    now: () => 1_000,
  };
}

describe("draftMonitor", () => {
  it("maps a NL request to a valid closed-registry draft that round-trips validateMonitorCreate", async () => {
    const out = await draftMonitor(
      "alert me if the staging instance's p95 latency goes above 500ms",
      { id: "inst_abc", name: "staging-x", kind: "staging" },
      deps({
        raw: {
          canDraft: true,
          name: "staging p95 latency",
          checkType: "metric_threshold",
          target: { kind: "instanceType", value: "staging" },
          params: { metric: "latency_ms", agg: "p95", comparator: ">", value: 500, severity: "warn" },
          intervalSec: 300,
          retries: 3,
          rationale: "Watches staging p95 latency and warns past 500ms.",
        },
      }),
    );
    expect(out.canDraft).toBe(true);
    expect(out.draft).not.toBeNull();
    expect(out.draft?.checkType).toBe("metric_threshold");
    expect(out.draft?.target).toEqual({ kind: "instanceType", value: "staging" });
    expect(out.draft?.params.metric).toBe("latency_ms");
    expect(out.rationale).toContain("p95");
    // The draft is EXACTLY a valid create payload — re-validating it must not throw.
    expect(() => validateMonitorCreate(out.draft)).not.toThrow();
    expect(out.model).toBe("claude-sonnet-4-6");
  });

  it("honestly abstains (canDraft=false, no draft) when the request needs an unsupported check", async () => {
    const out = await draftMonitor(
      "run a full playwright checkout flow every 10 minutes",
      undefined,
      deps({
        raw: {
          canDraft: false,
          unsupportedReason:
            "Synthetic browser flows aren't a supported check-type. Closest: http_reachability on the checkout URL.",
          rationale: "This needs a synthetic browser test, which isn't in the closed check-type set.",
        },
      }),
    );
    expect(out.canDraft).toBe(false);
    expect(out.draft).toBeNull();
    expect(out.warnings.join(" ")).toContain("Synthetic browser flows");
  });

  it("rejects (abstains on) a draft that fails the create validator — never returns something unbuildable", async () => {
    const out = await draftMonitor(
      "watch cpu on convex",
      undefined,
      deps({
        raw: {
          canDraft: true,
          name: "cpu",
          checkType: "metric_threshold",
          // instance_status doesn't allow a 'url' selector; here metric_threshold is
          // fine but we omit the REQUIRED comparator/value so the param schema 400s.
          target: { kind: "serviceType", value: "convex" },
          params: { metric: "cpu" }, // missing comparator + value
          rationale: "cpu guard",
        },
      }),
    );
    expect(out.canDraft).toBe(false);
    expect(out.draft).toBeNull();
    expect(out.warnings.join(" ")).toContain("didn't validate");
  });

  it("abstains when the model names a check-type outside the closed registry", async () => {
    const out = await draftMonitor(
      "monitor the queue depth",
      undefined,
      deps({
        raw: {
          canDraft: true,
          name: "queue depth",
          checkType: "queue_health", // not in CHECK_TYPE_IDS
          target: { kind: "all" },
          params: {},
          rationale: "queue depth",
        },
      }),
    );
    expect(out.canDraft).toBe(false);
    expect(out.draft).toBeNull();
  });

  it("degrades cleanly (no model call) when AI isn't configured", async () => {
    const callSpy = vi.fn(async () => ({}) as unknown);
    const out = await draftMonitor("anything", undefined, deps({ configured: false, callSpy }));
    expect(callSpy).not.toHaveBeenCalled();
    expect(out.configured).toBe(false);
    expect(out.canDraft).toBe(false);
    expect(out.draft).toBeNull();
    expect(out.warnings.join(" ")).toContain("not configured");
  });

  it("adds a non-fatal grounding warning when a metric_threshold metric isn't in recent series", async () => {
    const out = await draftMonitor(
      "warn if error_rate > 5 on convex",
      undefined,
      deps({
        raw: {
          canDraft: true,
          name: "error rate",
          checkType: "metric_threshold",
          target: { kind: "serviceType", value: "convex" },
          params: { metric: "error_rate", comparator: ">", value: 5, severity: "warn" },
          rationale: "watch error_rate",
        },
        // Known series don't include error_rate → expect a "confirm the name" warning.
        facets: async () => ({ rows: [{ metric: "latency_ms" }, { metric: "cpu" }] }),
      }),
    );
    expect(out.canDraft).toBe(true);
    expect(out.draft).not.toBeNull();
    expect(out.warnings.join(" ")).toContain("error_rate");
  });
});
