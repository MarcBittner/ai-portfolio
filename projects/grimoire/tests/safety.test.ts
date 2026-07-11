import { describe, expect, it } from "vitest";

import { scanContent, worstSeverity } from "../lib/safety";

describe("scanContent", () => {
  it("flags real secret values", () => {
    const hits = scanContent("here is the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
    expect(hits.some((h) => h.severity === "critical")).toBe(true);
  });

  it("flags a mongo connection string with credentials", () => {
    const hits = scanContent("mongodb+srv://user:p4ssw0rd@cluster.mongodb.net/db");
    expect(hits.some((h) => h.label.includes("Mongo"))).toBe(true);
  });

  it("flags SSN and HR terms", () => {
    expect(scanContent("SSN 123-45-6789").some((h) => h.label === "US SSN")).toBe(true);
    expect(scanContent("see the offer letter and base salary").length).toBeGreaterThan(0);
  });

  it("does NOT flag docs that merely describe config (env var names)", () => {
    const doc =
      "Set `ANTHROPIC_API_KEY` via the environment. `JWT_SECRET` must be set; " +
      "ask your manager for the password manager. Use `process.env.STRIPE_SECRET_KEY`.";
    expect(scanContent(doc)).toEqual([]);
  });

  it("does NOT flag construction dollar amounts (domain data, not comp)", () => {
    const doc = "CO-014: a $48,000 rooftop HVAC reroute, exampleified at $44,200 (92%). Threshold $250,000.";
    expect(scanContent(doc)).toEqual([]);
  });

  it("returns clean for ordinary prose", () => {
    expect(scanContent("This runbook explains how deploys work. Nothing secret here.")).toEqual([]);
  });

  it("worstSeverity picks the highest", () => {
    expect(worstSeverity([{ severity: "low", label: "x", context: "" }, { severity: "high", label: "y", context: "" }])).toBe("high");
    expect(worstSeverity([])).toBeNull();
  });
});
