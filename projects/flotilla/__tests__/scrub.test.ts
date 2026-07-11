import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubExportDir, scanResidualEmails, makeScrubber, DEFAULT_SCRUB_DOMAIN } from "../lib/scrub.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeTable(dir: string, table: string, rows: object[]): void {
  const d = path.join(dir, table);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "documents.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function readTable(dir: string, table: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(dir, table, "documents.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function buildFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  writeTable(dir, "users", [
    { _id: "u1", email: "Alice@Real.com", phoneNumber: "+1 617 555 0100", authId: "https://prod.clerk|user_abc", name: "Alice" },
    { _id: "u2", email: "bob@real.com", authId: "https://prod.clerk|user_def" },
  ]);
  writeTable(dir, "changeOrders", [
    { _id: "co1", foreverId: "FID-KEEP-1", amount: 12345, approvedAmount: 6789, pauseHoldUntil: 1720000000000 },
  ]);
  writeTable(dir, "scheduledReports", [
    { _id: "sr1", isActive: true, recipientEmails: ["Alice@Real.com", "carol@real.com"] },
  ]);
  writeTable(dir, "emailMessages", [
    { _id: "em1", subject: "hi bob@real.com", body: "contact alice@real.com please" },
  ]);
  // A non-scrubbed table + storage copied verbatim.
  writeTable(dir, "contracts", [{ _id: "c1", value: 999 }]);
  const storage = path.join(dir, "_storage");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "blob.bin"), "binary-bytes");
}

describe("scrubExportDir", () => {
  it("scrubs PII, remaps authId, neutralizes async, and KEEPS foreverId + amounts", () => {
    const inDir = path.join(root, "in");
    const outDir = path.join(root, "out");
    buildFixture(inDir);
    scrubExportDir(inDir, outDir);

    const users = readTable(outDir, "users");
    expect(users[0].email).toMatch(new RegExp(`^u[0-9a-f]{10}@${DEFAULT_SCRUB_DOMAIN}$`));
    expect(users[0].authId).toBe(`pending:${users[0].email}`);
    expect(users[0].phoneNumber).toMatch(/^\+1-555-\d{4}$/);
    // Same person → same scrubbed address across tables (relationship-preserving).
    const reports = readTable(outDir, "scheduledReports");
    expect(reports[0].recipientEmails).toContain(users[0].email);
    expect(reports[0].isActive).toBe(false); // async-neutralized

    const co = readTable(outDir, "changeOrders")[0];
    expect(co.foreverId).toBe("FID-KEEP-1"); // legal id kept
    expect(co.amount).toBe(12345); // financials untouched
    expect(co.approvedAmount).toBe(6789);
    expect("pauseHoldUntil" in co).toBe(false); // async-neutralized

    const em = readTable(outDir, "emailMessages")[0];
    expect(em.subject).not.toContain("bob@real.com");
    expect(em.body).not.toContain("alice@real.com");

    // Non-scrubbed table + storage copied verbatim.
    expect(readTable(outDir, "contracts")[0].value).toBe(999);
    expect(fs.readFileSync(path.join(outDir, "_storage", "blob.bin"), "utf8")).toBe("binary-bytes");
  });

  it("is idempotent: scrubbing the output again is byte-identical", () => {
    const inDir = path.join(root, "in");
    const out1 = path.join(root, "out1");
    const out2 = path.join(root, "out2");
    buildFixture(inDir);
    scrubExportDir(inDir, out1);
    scrubExportDir(out1, out2); // re-scrub the scrubbed export

    for (const table of ["users", "changeOrders", "scheduledReports", "emailMessages", "contracts"]) {
      const a = fs.readFileSync(path.join(out1, table, "documents.jsonl"), "utf8");
      const b = fs.readFileSync(path.join(out2, table, "documents.jsonl"), "utf8");
      expect(b).toBe(a);
    }
  });

  it("is deterministic: same input → same scrubbed address", () => {
    const s1 = makeScrubber();
    const s2 = makeScrubber();
    expect(s1.email("X@Y.com")).toBe(s2.email("x@y.com")); // case-insensitive + stable
  });
});

describe("scanResidualEmails", () => {
  it("reports zero on a fully scrubbed export", () => {
    const inDir = path.join(root, "in");
    const outDir = path.join(root, "out");
    buildFixture(inDir);
    scrubExportDir(inDir, outDir);
    expect(scanResidualEmails(outDir).count).toBe(0);
  });

  it("flags a leaked real email (non-zero)", () => {
    const dir = path.join(root, "leaky");
    writeTable(dir, "users", [{ _id: "u9", email: "leak@real.com" }]);
    const scan = scanResidualEmails(dir);
    expect(scan.count).toBeGreaterThan(0);
    expect(scan.samples[0]).toContain("leak@real.com");
  });
});
