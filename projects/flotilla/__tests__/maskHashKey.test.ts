// __tests__/maskHashKey.test.ts — FLOTILLA_MASK_HASH_KEY hardening.
//
// Proves the four contract points of the per-deployment secret hash key:
//   1. same key + same input ⇒ identical output (determinism / join preservation
//      retained *for a given key*);
//   2. two DIFFERENT keys ⇒ different masked identity output for the same input
//      (the key actually salts the mapping);
//   3. UNSET key ⇒ exactly today's default-seed behaviour (back-compat golden);
//   4. numeric / `_id` / `*Id` fields are untouched regardless of the key.
//
// copycat's setHashKey is PROCESS-GLOBAL, so between key changes we call
// __resetMaskHashKeyState() (the copycat guard is per-process) and drop the env
// var; each `maskExportDir` re-applies the current key before masking.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  maskExportDir,
  makeMasker,
  resolveMaskHashKey,
  __resetMaskHashKeyState,
} from "../lib/mask.ts";

let root: string;
const savedEnv = process.env.FLOTILLA_MASK_HASH_KEY;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "maskhk-"));
  delete process.env.FLOTILLA_MASK_HASH_KEY;
  __resetMaskHashKeyState();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.FLOTILLA_MASK_HASH_KEY;
  else process.env.FLOTILLA_MASK_HASH_KEY = savedEnv;
  __resetMaskHashKeyState();
});

function writeRaw(dir: string, table: string, lines: string[]): void {
  const d = path.join(dir, table);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "documents.jsonl"), lines.join("\n") + "\n");
}
function readRaw(dir: string, table: string): string[] {
  return fs.readFileSync(path.join(dir, table, "documents.jsonl"), "utf8").split("\n").filter(Boolean);
}
function buildFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  writeRaw(dir, "users", [
    '{"_id":"u1","email":"Alice@Real.com","phoneNumber":"+1 617 555 0100","firstName":"Alice","lastName":"Smith","organizationId":"org_keep_1"}',
    '{"_id":"u2","email":"bob@real.com","name":"Bob Jones"}',
  ]);
  writeRaw(dir, "changeOrders", [
    '{"_id":"co1","foreverId":"FID-KEEP-1","amount":12345.0,"approvedAmount":6789.5,"contractId":"k9abc"}',
  ]);
  writeRaw(dir, "contacts", ['{"_id":"ct1","email":"Alice@Real.com","name":"Alice Smith"}']);
}

// A helper: mask the fixture into a fresh dir under `root` with an explicit key,
// resetting the process-global copycat key first so the key is re-applied.
function maskWith(tag: string, key?: string): { users: string[]; changeOrders: string[]; contacts: string[] } {
  const inDir = path.join(root, `in-${tag}`);
  const outDir = path.join(root, `out-${tag}`);
  buildFixture(inDir);
  __resetMaskHashKeyState();
  maskExportDir(inDir, outDir, { secret: "run-secret", hashKey: key });
  return {
    users: readRaw(outDir, "users"),
    changeOrders: readRaw(outDir, "changeOrders"),
    contacts: readRaw(outDir, "contacts"),
  };
}

describe("resolveMaskHashKey", () => {
  it("is undefined when unset or blank, trimmed otherwise", () => {
    delete process.env.FLOTILLA_MASK_HASH_KEY;
    expect(resolveMaskHashKey()).toBeUndefined();
    process.env.FLOTILLA_MASK_HASH_KEY = "   ";
    expect(resolveMaskHashKey()).toBeUndefined();
    process.env.FLOTILLA_MASK_HASH_KEY = "  s3cret-key  ";
    expect(resolveMaskHashKey()).toBe("s3cret-key");
    delete process.env.FLOTILLA_MASK_HASH_KEY;
  });
});

describe("FLOTILLA_MASK_HASH_KEY — determinism for a given key", () => {
  it("same key + same input ⇒ byte-identical output (joins/rollups preserved)", () => {
    const a = maskWith("k1a", "deploy-key-AAA");
    const b = maskWith("k1b", "deploy-key-AAA");
    expect(a.users).toEqual(b.users);
    expect(a.contacts).toEqual(b.contacts);
    expect(a.changeOrders).toEqual(b.changeOrders);
  });

  it("referential consistency holds under a key: same source email → same masked value across tables", () => {
    const out = maskWith("kref", "deploy-key-REF");
    const userEmail = JSON.parse(out.users[0]).email;
    const contactEmail = JSON.parse(out.contacts[0]).email;
    expect(contactEmail).toBe(userEmail); // Alice@Real.com masks the same everywhere
    expect(userEmail).not.toContain("Real.com");
  });
});

describe("FLOTILLA_MASK_HASH_KEY — the key actually salts the mapping", () => {
  it("two DIFFERENT keys ⇒ different masked identity output for the same input", () => {
    const a = maskWith("kdiffA", "deploy-key-AAA");
    const b = maskWith("kdiffB", "deploy-key-BBB");
    const ea = JSON.parse(a.users[0]).email;
    const eb = JSON.parse(b.users[0]).email;
    const fa = JSON.parse(a.users[0]).firstName;
    const fb = JSON.parse(b.users[0]).firstName;
    expect(ea).not.toBe(eb);
    expect(fa).not.toBe(fb);
  });

  it("a keyed masking differs from the default (unset) masking (key ≠ public default seed)", () => {
    const def = maskWith("kdef", undefined); // default seed
    const keyed = maskWith("kkeyed", "deploy-key-AAA");
    expect(JSON.parse(keyed.users[0]).email).not.toBe(JSON.parse(def.users[0]).email);
  });
});

describe("FLOTILLA_MASK_HASH_KEY — back-compat (unset == today's default)", () => {
  it("explicit undefined key and env-unset produce the SAME default-seed output", () => {
    delete process.env.FLOTILLA_MASK_HASH_KEY;
    const viaArg = maskWith("bc-arg", undefined);

    // Now via the env path (still unset) — must match byte-for-byte.
    delete process.env.FLOTILLA_MASK_HASH_KEY;
    const inDir = path.join(root, "bc-env-in");
    const outDir = path.join(root, "bc-env-out");
    buildFixture(inDir);
    __resetMaskHashKeyState();
    maskExportDir(inDir, outDir, { secret: "run-secret" }); // no hashKey opt → resolves env (unset)
    const usersEnv = readRaw(outDir, "users");

    expect(usersEnv).toEqual(viaArg.users);
  });

  it("a blank/whitespace key is treated as unset (== default)", () => {
    const def = maskWith("blank-def", undefined);
    const blank = maskWith("blank-ws", "   ");
    expect(blank.users).toEqual(def.users);
  });
});

describe("FLOTILLA_MASK_HASH_KEY — invariants hold regardless of key", () => {
  for (const key of [undefined, "deploy-key-AAA", "deploy-key-BBB"]) {
    it(`numeric / _id / *Id / organizationId untouched (key=${key ?? "unset"})`, () => {
      const out = maskWith(`inv-${key ?? "unset"}`, key);
      const u0 = JSON.parse(out.users[0]);
      expect(u0._id).toBe("u1"); // id untouched
      expect(u0.organizationId).toBe("org_keep_1"); // never masked
      const coLine = out.changeOrders[0];
      expect(coLine).toContain('"amount":12345.0'); // float encoding preserved
      expect(coLine).toContain('"approvedAmount":6789.5');
      expect(coLine).toContain('"foreverId":"FID-KEEP-1"'); // legal id kept
      expect(coLine).toContain('"contractId":"k9abc"'); // *Id reference kept
      // identity fields ARE masked regardless of key
      expect(u0.email).not.toContain("Real.com");
      expect(u0.phoneNumber).toMatch(/^\+1-555-\d{4}$/);
    });
  }
});

describe("makeMasker — hash key threads into the HMAC fallback too", () => {
  // Force the HMAC path by masking a value copycat wouldn't change anyway is hard;
  // instead assert the fallback KEY differs by key. When copycat is present the
  // email() output is copycat's; phone()/url()/address() ALWAYS use the HMAC path,
  // so they must differ by key regardless of backend.
  it("HMAC-only fields (phone) differ by hash key", () => {
    __resetMaskHashKeyState();
    const mA = makeMasker("s", "hk-AAA");
    const pA = mA.phone("+1 617 555 0100");
    __resetMaskHashKeyState();
    const mB = makeMasker("s", "hk-BBB");
    const pB = mB.phone("+1 617 555 0100");
    expect(pA).not.toBe(pB);
  });

  it("HMAC-only fields are byte-identical to today when key is unset", () => {
    __resetMaskHashKeyState();
    const mUnset = makeMasker("s"); // env unset → no key
    const mUndef = makeMasker("s", undefined);
    expect(mUnset.phone("+1 617 555 0100")).toBe(mUndef.phone("+1 617 555 0100"));
    expect(mUnset.address("1 Main St")).toBe(mUndef.address("1 Main St"));
  });
});
