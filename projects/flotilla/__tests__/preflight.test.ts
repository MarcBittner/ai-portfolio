import { describe, it, expect, afterEach } from "vitest";
import {
  checkTarget,
  checkEmailGuard,
  inCronWindow,
  assertNotInCronWindow,
  residualEmailGate,
  parseArgs,
  STAGING_PROD_DEPLOYMENT,
  STAGING_DEV_DEPLOYMENT,
  DEV_DEPLOYMENT,
} from "../scripts/refresh-staging.ts";
import { PROD_CONVEX_DEPLOYMENT } from "../lib/provision.ts";

afterEach(() => { delete process.env.I_VERIFIED_PROD_CONFIRM; });

describe("checkTarget", () => {
  it("accepts staging-prod as the real target", () => {
    expect(() => checkTarget({ target: STAGING_PROD_DEPLOYMENT })).not.toThrow();
  });

  it("hard-refuses prod without the flag", () => {
    expect(() => checkTarget({ target: PROD_CONVEX_DEPLOYMENT })).toThrow(/PRODUCTION/);
  });

  it("refuses prod even with the flag until out-of-band confirm env is set", () => {
    expect(() => checkTarget({ target: PROD_CONVEX_DEPLOYMENT, iVerifiedProdName: true })).toThrow(/out-of-band/);
    process.env.I_VERIFIED_PROD_CONFIRM = PROD_CONVEX_DEPLOYMENT;
    expect(() => checkTarget({ target: PROD_CONVEX_DEPLOYMENT, iVerifiedProdName: true })).not.toThrow();
  });

  it("allows rehearsal deployments only under --dry-run", () => {
    expect(() => checkTarget({ target: STAGING_DEV_DEPLOYMENT, dryRun: true })).not.toThrow();
    expect(() => checkTarget({ target: DEV_DEPLOYMENT, dryRun: true })).not.toThrow();
    expect(() => checkTarget({ target: DEV_DEPLOYMENT, dryRun: false })).toThrow(/only allowed with --dry-run/);
  });

  it("rejects unknown targets", () => {
    expect(() => checkTarget({ target: "some-random-42" })).toThrow(/unknown target/);
  });
});

describe("checkEmailGuard", () => {
  it("throws when the kill-switch is on (prod marker)", () => {
    expect(() => checkEmailGuard("true")).toThrow(/ALLOW_OUTBOUND_EMAIL/);
  });
  it("passes when unset or off", () => {
    expect(() => checkEmailGuard(undefined)).not.toThrow();
    expect(() => checkEmailGuard("false")).not.toThrow();
  });
});

describe("cron window", () => {
  it("detects the 09:00–10:00 UTC window", () => {
    expect(inCronWindow(new Date("2026-07-02T09:30:00Z"))).toBe(true);
    expect(inCronWindow(new Date("2026-07-02T10:00:00Z"))).toBe(false);
    expect(inCronWindow(new Date("2026-07-02T08:59:59Z"))).toBe(false);
  });
  it("refuses to run in-window unless forced", () => {
    const inWin = new Date("2026-07-02T09:15:00Z");
    expect(() => assertNotInCronWindow(inWin, false)).toThrow(/cron window/);
    expect(() => assertNotInCronWindow(inWin, true)).not.toThrow();
    expect(() => assertNotInCronWindow(new Date("2026-07-02T12:00:00Z"), false)).not.toThrow();
  });
});

describe("residualEmailGate", () => {
  it("throws (non-zero exit) when any real email remains", () => {
    expect(() => residualEmailGate({ count: 2, samples: ["users: a@real.com"] })).toThrow(/residual real-email/);
  });
  it("passes on a clean scan", () => {
    expect(() => residualEmailGate({ count: 0, samples: [] })).not.toThrow();
  });
});

describe("parseArgs", () => {
  it("defaults to staging-prod with migrations+scrub on", () => {
    const a = parseArgs(["--prod-backup", "/x.zip"]);
    expect(a.target).toBe(STAGING_PROD_DEPLOYMENT);
    expect(a.migrations).toBe(true);
    expect(a.scrub).toBe(true);
    expect(a.dryRun).toBe(false);
  });
  it("honors toggles", () => {
    const a = parseArgs(["--no-migrations", "--no-scrub", "--dry-run", "--force", "--target", DEV_DEPLOYMENT]);
    expect(a.migrations).toBe(false);
    expect(a.scrub).toBe(false);
    expect(a.dryRun).toBe(true);
    expect(a.force).toBe(true);
    expect(a.target).toBe(DEV_DEPLOYMENT);
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
  });
});
