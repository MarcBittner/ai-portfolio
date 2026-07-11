import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  maskExportDir,
  maskJsonLine,
  makeMasker,
  classifyField,
  type LineRewriter,
} from "../lib/mask.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mask-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Write RAW JSONL text (not via JSON.stringify) so we can assert Convex's float
// encoding (`1234.0`) survives — a JSON round-trip would silently drop it.
function writeRaw(dir: string, table: string, lines: string[]): void {
  const d = path.join(dir, table);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "documents.jsonl"), lines.join("\n") + "\n");
}
function readRaw(dir: string, table: string): string[] {
  return fs.readFileSync(path.join(dir, table, "documents.jsonl"), "utf8").split("\n").filter(Boolean);
}

describe("maskJsonLine — string-level rewrite preserves encoding", () => {
  const rw: LineRewriter = {
    maskValue: (key) => (classifyField(key) === "email" ? "masked@masked.invalid" : undefined),
    rootOverride: () => undefined,
  };

  it("preserves float encoding (1234.0) and integer/exponent forms while masking a sibling string", () => {
    const src = '{"_id":"abc","email":"real@corp.com","amount":1234.0,"qty":5,"rate":1.0e3}';
    const out = maskJsonLine(src, rw);
    expect(out).toContain('"amount":1234.0'); // NOT 1234
    expect(out).toContain('"rate":1.0e3');
    expect(out).toContain('"qty":5');
    expect(out).toContain('"email":"masked@masked.invalid"');
    expect(out).toContain('"_id":"abc"'); // _id untouched
  });

  it("leaves a line with no targeted fields byte-identical", () => {
    const src = '{"_id":"x","value":999.0,"note":123}';
    expect(maskJsonLine(src, rw)).toBe(src);
  });

  it("masks string elements of an array under the parent key", () => {
    const src = '{"recipientEmails":["a@x.com","b@y.com"],"count":2.0}';
    const out = maskJsonLine(src, {
      maskValue: (key, v) => (classifyField(key) === "email" ? `masked(${v.length})` : undefined),
      rootOverride: () => undefined,
    });
    expect(out).toContain('"count":2.0');
    expect(out).toContain('masked(');
  });
});

describe("maskExportDir — full export", () => {
  function buildFixture(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    writeRaw(dir, "users", [
      '{"_id":"u1","email":"Alice@Real.com","phoneNumber":"+1 617 555 0100","firstName":"Alice","lastName":"Smith","authId":"https://prod.clerk|user_abc","organizationId":"org_keep_1"}',
      '{"_id":"u2","email":"bob@real.com","authId":"https://prod.clerk|user_def"}',
    ]);
    writeRaw(dir, "changeOrders", [
      '{"_id":"co1","foreverId":"FID-KEEP-1","amount":12345.0,"approvedAmount":6789.5,"pauseHoldUntil":1720000000000,"contractId":"k9abc"}',
    ]);
    writeRaw(dir, "scheduledReports", [
      '{"_id":"sr1","isActive":true,"recipientEmails":["Alice@Real.com","carol@real.com"]}',
    ]);
    writeRaw(dir, "contacts", [
      '{"_id":"ct1","email":"Alice@Real.com","name":"Alice Smith"}',
    ]);
    // A value that LOOKS like a Convex id must not be masked even in a name field.
    writeRaw(dir, "widgets", [
      '{"_id":"w1","name":"k170abcdefghijklmnopqrstuvwxyz12"}',
    ]);
    writeRaw(dir, "contracts", ['{"_id":"c1","value":999.0}']);
    const storage = path.join(dir, "_storage");
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, "blob.bin"), "binary-bytes");
  }

  it("masks identity PII, preserves financials + ids, neutralizes async, keeps foreverId", () => {
    const inDir = path.join(root, "in");
    const outDir = path.join(root, "out");
    buildFixture(inDir);
    const report = maskExportDir(inDir, outDir, { secret: "run-secret-1" });

    const users = readRaw(outDir, "users").map((l) => JSON.parse(l));
    expect(users[0]._id).toBe("u1"); // id untouched
    expect(users[0].organizationId).toBe("org_keep_1"); // never masked
    expect(users[0].email).not.toBe("alice@real.com");
    expect(users[0].email).not.toContain("Real.com");
    expect(users[0].firstName).not.toBe("Alice");
    expect(users[0].phoneNumber).toMatch(/^\+1-555-\d{4}$/);
    // authId is NEVER touched by masking (resetAuthIds handles it post-import).
    expect(users[0].authId).toBe("https://prod.clerk|user_abc");

    // Referential consistency: same source email → same masked value everywhere.
    const contacts = readRaw(outDir, "contacts").map((l) => JSON.parse(l));
    const reports = readRaw(outDir, "scheduledReports").map((l) => JSON.parse(l));
    expect(contacts[0].email).toBe(users[0].email);
    expect(reports[0].recipientEmails).toContain(users[0].email);
    expect(reports[0].isActive).toBe(false); // async-neutralized

    // changeOrders: number ENCODING preserved (raw text), pauseHoldUntil deleted.
    const coLine = readRaw(outDir, "changeOrders")[0];
    expect(coLine).toContain('"amount":12345.0'); // float encoding kept
    expect(coLine).toContain('"approvedAmount":6789.5');
    expect(coLine).toContain('"foreverId":"FID-KEEP-1"'); // legal id kept
    expect(coLine).not.toContain("pauseHoldUntil"); // neutralized
    expect(coLine).toContain('"contractId":"k9abc"'); // reference kept

    // Convex-id-looking value left alone even though key is `name`.
    const widget = JSON.parse(readRaw(outDir, "widgets")[0]);
    expect(widget.name).toBe("k170abcdefghijklmnopqrstuvwxyz12");

    // Non-targeted table + storage copied verbatim.
    expect(readRaw(outDir, "contracts")[0]).toContain('"value":999.0');
    expect(fs.readFileSync(path.join(outDir, "_storage", "blob.bin"), "utf8")).toBe("binary-bytes");

    expect(report.tables).toBeGreaterThan(0);
    expect(report.changedRows).toBeGreaterThan(0);
  });

  it("is deterministic across runs with the same secret", () => {
    const inDir = path.join(root, "in");
    buildFixture(inDir);
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    maskExportDir(inDir, a, { secret: "same" });
    maskExportDir(inDir, b, { secret: "same" });
    expect(readRaw(a, "users")).toEqual(readRaw(b, "users"));
  });

  it("different secrets reshuffle the mapping", () => {
    const inDir = path.join(root, "in");
    buildFixture(inDir);
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    maskExportDir(inDir, a, { secret: "one" });
    maskExportDir(inDir, b, { secret: "two" });
    const ea = JSON.parse(readRaw(a, "users")[0]).email;
    const eb = JSON.parse(readRaw(b, "users")[0]).email;
    expect(ea).not.toBe(eb);
  });
});

describe("classifyField", () => {
  it("classifies identity fields and refuses references", () => {
    expect(classifyField("email")).toBe("email");
    expect(classifyField("billingEmail")).toBe("email");
    expect(classifyField("firstName")).toBe("firstName");
    expect(classifyField("companyName")).toBe("name");
    expect(classifyField("phoneNumber")).toBe("phone");
    expect(classifyField("avatarUrl")).toBe("url");
    expect(classifyField("_id")).toBeNull();
    expect(classifyField("organizationId")).toBeNull();
    expect(classifyField("contractId")).toBeNull(); // *Id reference
    expect(classifyField("authId")).toBeNull();
    expect(classifyField("amount")).toBeNull();
  });
});

describe("makeMasker", () => {
  it("is referentially consistent and idempotent within a run", () => {
    const m = makeMasker("s");
    const a = m.email("X@Y.com");
    const b = m.email("x@y.com".toUpperCase().toLowerCase());
    expect(a).toBe(b);
    // Re-masking an already-produced value is a no-op (f(f(x)) === f(x)).
    expect(m.email(a)).toBe(a);
  });
});
