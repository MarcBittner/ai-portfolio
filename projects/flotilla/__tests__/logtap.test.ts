import { describe, it, expect } from "vitest";
import { makeLogger, formatLogEvent, type LogEvent } from "../lib/logtap.ts";

describe("logtap", () => {
  it("merges events from multiple sources into one ordered buffer + forwards to sink", () => {
    const sink: LogEvent[] = [];
    let t = 1000;
    const log = makeLogger((e) => sink.push(e), { now: () => t++ });

    const v = log.for("vercel");
    const c = log.for("convex");
    v("info", "deploy start");
    c("warn", "import slow");
    log.log("orchestrator", "error", "boom");

    // Same buffer, arrival order preserved, sink got each event once.
    expect(log.events.map((e) => e.source)).toEqual(["vercel", "convex", "orchestrator"]);
    expect(sink).toHaveLength(3);
    expect(sink).toEqual([...log.events]);
    expect(log.events.map((e) => e.ts)).toEqual([1000, 1001, 1002]);
  });

  it("job-scoped child shares the parent buffer and tags jobId", () => {
    const log = makeLogger();
    const child = log.withJob("job-42");
    child.for("convex")("info", "run mutation");
    log.log("orchestrator", "info", "no job");

    expect(child.events).toBe(log.events); // consolidated
    expect(log.events[0].jobId).toBe("job-42");
    expect(log.events[1].jobId).toBeUndefined();
  });

  it("formats a readable single line", () => {
    const line = formatLogEvent({ source: "convex", level: "warn", ts: 0, msg: "hi", jobId: "j1" });
    expect(line).toContain("WARN");
    expect(line).toContain("convex");
    expect(line).toContain("[j1]");
    expect(line).toContain("hi");
  });
});
