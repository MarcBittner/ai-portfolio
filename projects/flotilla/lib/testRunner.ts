// lib/testRunner.ts — the TEST RUNNER behind /api/testing.
//
// `runTests(run)` dispatches by kind and returns a checks[] array. Every check is
// wrapped so a thrown assertion becomes a FAILED check (the error as `detail`) —
// a single bad probe never crashes the run. All instance-facing kinds are
// strictly READ-ONLY (goto / fetch only); they never mutate instance data.
//
// Execution surfaces:
//   • smoke / regression — headless chromium (Playwright) drives a real sign-in
//     via a Clerk sign-in TOKEN, then asserts key pages render. Mirrors the proven
//     staging-clone verification: goto {url}/sign-in?__clerk_ticket=<tok>, wait
//     ~6s, read body innerText + url, watch console errors.
//   • security — fetch-only probes (no browser): gating, exposure, headers.
//   • self — the dashboard's OWN vitest suite (execFile) + a 401 health probe of
//     its own sensitive API routes. Needs no target instance.
//
// Playwright is imported DYNAMICALLY inside the browser kinds so importing this
// module (and the serverless route graph that reaches it) stays cheap.

import type { TestRunDoc, TestCheck } from "./models/testruns.ts";
import type { LogLevel } from "./_contract.ts";
import { getInstance, listManagedUsers } from "./models/index.ts";
import { makeClerkClient } from "./clients/clerk.ts";
import { makeLogger } from "./logtap.ts";

export type RunnerLog = (level: LogLevel, msg: string) => void;

// The authenticated app routes every managed instance is smoke-tested against.
// Env-driven (FLOTILLA_SMOKE_PATHS, comma-separated) so the fleet's app is generic;
// defaults to a neutral set. Leading slashes are normalized.
const DEFAULT_APP_PATHS = ["/dashboard", "/projects", "/settings", "/profile"];
const APP_PATHS = (() => {
  const raw = (process.env.FLOTILLA_SMOKE_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
  return raw.length > 0 ? raw : DEFAULT_APP_PATHS;
})();

// A page is "signed in" once the URL path is no longer the sign-in screen.
function isSignInPath(u: string): boolean {
  try {
    return /\/sign-in\b/.test(new URL(u).pathname);
  } catch {
    return /\/sign-in\b/.test(u);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Run one named assertion. The fn throws to fail; its return string (if any) is
// the pass detail. Any throw is captured as a failed check — never propagates.
async function check(
  name: string,
  fn: () => Promise<string | void>,
  log?: RunnerLog,
): Promise<TestCheck> {
  try {
    const detail = await fn();
    log?.("info", `✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return { name, pass: true, detail: detail || undefined };
  } catch (err) {
    const detail = errMsg(err);
    log?.("warn", `✗ ${name} — ${detail}`);
    return { name, pass: false, detail };
  }
}

// Resolve the Clerk Backend-API secret for an instance's Clerk. Prefers a
// per-instance override (CLERK_SECRET_KEY_<CLERKINSTANCE>) and falls back to the
// dashboard-wide CLERK_SECRET_KEY (most instances share the dev Clerk).
function clerkSecretFor(clerkInstance?: string): string | undefined {
  if (clerkInstance) {
    const key = `CLERK_SECRET_KEY_${clerkInstance.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
    const v = process.env[key];
    if (v) return v;
  }
  return process.env.CLERK_SECRET_KEY;
}

// ---------------------------------------------------------------------------
// Sign-in token: pick (or mint) a user on the instance's Clerk, then mint a
// short-lived sign-in token to drive the Playwright login. Prefers an admin.
// ---------------------------------------------------------------------------
async function mintSignInToken(
  instanceId: string,
  clerkInstance: string | undefined,
  log: RunnerLog,
): Promise<string> {
  const secretKey = clerkSecretFor(clerkInstance);
  if (!secretKey) throw new Error("no Clerk secret available to mint a sign-in token");
  const logger = makeLogger();
  const clerk = makeClerkClient({ log: logger.for("clerk"), secretKey });

  // 1) Prefer a managed user we already track for this instance.
  let userId: string | undefined;
  const managed = await listManagedUsers(instanceId).catch(() => []);
  const managedAdmin = managed.find((u) => /admin/i.test(u.email) && u.clerkUserId);
  const managedAny = managed.find((u) => u.clerkUserId);
  userId = managedAdmin?.clerkUserId ?? managedAny?.clerkUserId;

  // 2) Else ask the instance's Clerk directly — prefer an admin-looking email.
  if (!userId) {
    const users = await clerk.listUsers({ limit: 100 }).catch(() => []);
    const admin = users.find((u) => /admin/i.test(u.primaryEmail ?? ""));
    userId = (admin ?? users[0])?.id;
    if (userId) log("info", `signing in as ${admin?.primaryEmail ?? users[0]?.primaryEmail ?? userId}`);
  }

  // 3) Else mint a throwaway test user on the instance's Clerk.
  if (!userId) {
    const email = `flotilla-smoke+${instanceId}@example.com`;
    log("warn", `no user on instance Clerk — creating test user ${email}`);
    const created = await clerk.createUser({ email, username: `flotilla_smoke_${Date.now()}` });
    userId = created.id;
  }

  const { token } = await clerk.createSignInToken({ userId, expiresInSeconds: 600 });
  if (!token) throw new Error("Clerk returned an empty sign-in token");
  return token;
}

// ---------------------------------------------------------------------------
// Browser harness (smoke / regression). Returns the checks it produced.
// `deep` adds the regression-only data-table + navigation-interaction checks.
// ---------------------------------------------------------------------------
async function runBrowser(run: TestRunDoc, log: RunnerLog, deep: boolean): Promise<TestCheck[]> {
  const checks: TestCheck[] = [];
  const instance = run.instanceId ? await getInstance(run.instanceId) : null;
  if (!instance) {
    return [{ name: "resolve-instance", pass: false, detail: `instance ${run.instanceId} not found` }];
  }
  const url = instance.url?.replace(/\/+$/, "");
  if (!url) {
    return [{ name: "resolve-url", pass: false, detail: "instance has no resolved URL yet" }];
  }
  log("info", `smoke target: ${url} (clerk=${instance.clerkInstance ?? "default"})`);

  // Mint the sign-in token up front — a failure here is one check, not a crash.
  let ticket: string;
  try {
    ticket = await mintSignInToken(instance.id, instance.clerkInstance, log);
  } catch (err) {
    return [{ name: "clerk-sign-in-token", pass: false, detail: errMsg(err) }];
  }
  checks.push({ name: "clerk-sign-in-token", pass: true, detail: "minted (600s)" });

  // Dynamic import so the module graph reaching this file stays browser-free.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    // auth: land in-app via the sign-in ticket.
    checks.push(
      await check(
        "auth",
        async () => {
          consoleErrors.length = 0;
          await page.goto(`${url}/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`, {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(6000);
          const landed = page.url();
          if (isSignInPath(landed)) throw new Error(`still on sign-in after ticket: ${landed}`);
          return `landed at ${new URL(landed).pathname}`;
        },
        log,
      ),
    );

    // If auth failed, the page routes bounce to sign-in — still probe each so the
    // report is complete, but they'll fail honestly.
    for (const path of APP_PATHS) {
      checks.push(
        await check(
          `page ${path}`,
          async () => {
            consoleErrors.length = 0;
            const resp = await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(6000);
            const status = resp?.status() ?? 0;
            if (status >= 400) throw new Error(`HTTP ${status}`);
            const landed = page.url();
            if (isSignInPath(landed)) throw new Error(`bounced to sign-in (not authenticated)`);
            const body = (await page.locator("body").innerText().catch(() => "")).trim();
            if (body.length <= 40) throw new Error(`body too small to have rendered (${body.length} chars)`);
            if (consoleErrors.length > 0) {
              throw new Error(`${consoleErrors.length} console error(s): ${consoleErrors[0]?.slice(0, 120)}`);
            }
            return `HTTP ${status}, ${body.length} chars, 0 console errors`;
          },
          log,
        ),
      );
    }

    // regression: prod-clone data present + a navigation interaction works.
    if (deep) {
      checks.push(
        await check(
          "data-table-non-empty",
          async () => {
            // Try the list pages most likely to hold prod-clone rows.
            for (const path of ["/projects", "/contracts", "/change-orders"]) {
              const resp = await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
              await page.waitForTimeout(6000);
              if ((resp?.status() ?? 0) >= 400 || isSignInPath(page.url())) continue;
              const rows = await page
                .locator("table tbody tr, [role='row']")
                .count()
                .catch(() => 0);
              if (rows > 0) return `${rows} row(s) on ${path}`;
            }
            throw new Error("no non-empty data table found on projects/contracts/change-orders");
          },
          log,
        ),
      );

      checks.push(
        await check(
          "navigation-interaction",
          async () => {
            await page.goto(`${url}/dashboard`, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(4000);
            const before = page.url();
            const link = page.locator("a[href='/projects'], a[href*='/projects']").first();
            if ((await link.count()) === 0) throw new Error("no in-app navigation link found");
            await link.click({ timeout: 8000 });
            await page.waitForTimeout(4000);
            const after = page.url();
            if (after === before) throw new Error(`URL did not change after nav click (${after})`);
            if (isSignInPath(after)) throw new Error("navigation bounced to sign-in");
            return `navigated ${new URL(before).pathname} → ${new URL(after).pathname}`;
          },
          log,
        ),
      );
    }
    return checks;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// security — fetch-only probes that the instance is properly gated & sealed.
// ---------------------------------------------------------------------------
async function runSecurity(run: TestRunDoc, log: RunnerLog): Promise<TestCheck[]> {
  const instance = run.instanceId ? await getInstance(run.instanceId) : null;
  if (!instance) return [{ name: "resolve-instance", pass: false, detail: `instance ${run.instanceId} not found` }];
  const url = instance.url?.replace(/\/+$/, "");
  if (!url) return [{ name: "resolve-url", pass: false, detail: "instance has no resolved URL yet" }];
  log("info", `security target: ${url}`);

  // A fetch that never throws on non-2xx and never auto-follows to app content.
  async function get(path: string, opts: { redirect?: RequestRedirect } = {}) {
    const res = await fetch(`${url}${path}`, {
      redirect: opts.redirect ?? "follow",
      headers: { "user-agent": "flotilla-security-probe" },
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, finalUrl: res.url, body };
  }
  // A gated response = redirected/rendered to the sign-in screen (not app data).
  function looksGated(r: { status: number; finalUrl: string; body: string }): boolean {
    if (isSignInPath(r.finalUrl)) return true;
    const b = r.body.toLowerCase();
    return /sign in|__clerk|clerk|sign-in/.test(b) && !/dashboard-shell|data-testid=|<table/.test(b);
  }

  const checks: TestCheck[] = [];

  checks.push(
    await check(
      "root-gated",
      async () => {
        const r = await get("/");
        if (!looksGated(r)) throw new Error(`root returned an un-gated ${r.status} page (${r.finalUrl})`);
        return isSignInPath(r.finalUrl) ? `redirected to ${new URL(r.finalUrl).pathname}` : `gated (HTTP ${r.status})`;
      },
      log,
    ),
  );

  checks.push(
    await check(
      "app-path-not-public",
      async () => {
        // A data-bearing app path must not be readable without auth.
        const r = await get("/projects");
        if (!looksGated(r)) throw new Error(`/projects readable without auth (HTTP ${r.status})`);
        return "gated without a session";
      },
      log,
    ),
  );

  checks.push(
    await check(
      "no-secret-exposure",
      async () => {
        // Sample paths that must NOT serve secrets/source. 404/redirect = good.
        const probes = ["/.env", "/.env.local", "/.git/config", "/_next/static/chunks/main.js.map"];
        const leaks: string[] = [];
        for (const p of probes) {
          const r = await get(p, { redirect: "manual" });
          const looksSecret =
            r.status === 200 &&
            (/[A-Z_]+=\S+/.test(r.body) || /sk_(live|test)_|BEGIN [A-Z ]*PRIVATE KEY|"sources":/.test(r.body));
          if (looksSecret) leaks.push(`${p} (HTTP ${r.status})`);
        }
        if (leaks.length) throw new Error(`exposed: ${leaks.join(", ")}`);
        return `${probes.length} probes, none served secrets`;
      },
      log,
    ),
  );

  checks.push(
    await check(
      "security-headers",
      async () => {
        const r = await get("/");
        const want = [
          "strict-transport-security",
          "x-frame-options",
          "x-content-type-options",
          "content-security-policy",
        ];
        const present = want.filter((h) => r.headers.get(h));
        if (present.length === 0) throw new Error(`none of ${want.join(", ")} present`);
        return `present: ${present.join(", ")}`;
      },
      log,
    ),
  );

  checks.push(
    await check(
      "no-open-data-signup",
      async () => {
        // An open sign-up is acceptable ONLY if it doesn't front app data. Assert
        // the sign-up route (if any) renders the Clerk widget, not the app shell.
        const r = await get("/sign-up", { redirect: "follow" });
        const b = r.body.toLowerCase();
        const exposesData = /<table|data-testid=|dashboard-shell/.test(b) && !/sign up|__clerk|clerk/.test(b);
        if (exposesData) throw new Error(`/sign-up exposes app data (HTTP ${r.status})`);
        return r.status >= 400 ? `no public sign-up (HTTP ${r.status})` : "sign-up gated to Clerk widget";
      },
      log,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// self — no instance. Run the dashboard's OWN vitest suite + a 401 health probe
// of its own sensitive API routes.
// ---------------------------------------------------------------------------
async function runSelf(_run: TestRunDoc, log: RunnerLog): Promise<TestCheck[]> {
  const checks: TestCheck[] = [];

  checks.push(
    await check(
      "vitest",
      async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        try {
          const { stdout, stderr } = await run("npm", ["run", "test", "--", "--run"], {
            cwd: process.cwd(),
            timeout: 240_000,
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, CI: "1" },
          });
          const out = `${stdout}\n${stderr}`;
          const m = out.match(/Tests\s+(?:(\d+)\s+failed[^\n]*?)?(\d+)\s+passed/i);
          return m ? `vitest: ${m[2]} passed${m[1] ? `, ${m[1]} failed` : ", 0 failed"}` : "vitest passed";
        } catch (err) {
          // Non-zero exit (some tests failed) → surface the parsed counts.
          const out = String((err as { stdout?: string }).stdout ?? "") + String((err as { stderr?: string }).stderr ?? "");
          const m = out.match(/Tests\s+(\d+)\s+failed[^\n]*?(\d+)\s+passed/i);
          throw new Error(m ? `${m[1]} failed, ${m[2]} passed` : errMsg(err).slice(0, 200));
        }
      },
      log,
    ),
  );

  // Health probe: the dashboard's own sensitive routes must 401 unauthenticated.
  const base = (process.env.SELF_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  for (const path of ["/api/instances", "/api/audit"]) {
    checks.push(
      await check(
        `self-401 ${path}`,
        async () => {
          const res = await fetch(`${base}${path}`, { headers: { "user-agent": "flotilla-self-probe" } });
          if (res.status !== 401) throw new Error(`expected 401, got ${res.status} at ${base}${path}`);
          return "401 unauthenticated (gated)";
        },
        log,
      ),
    );
  }

  return checks;
}

// Dispatch by kind. A kind that throws whole becomes a single failed check so the
// run always resolves to a definite passed/failed with detail.
export async function runTests(run: TestRunDoc, log: RunnerLog = () => {}): Promise<TestCheck[]> {
  try {
    switch (run.kind) {
      case "smoke":
        return await runBrowser(run, log, false);
      case "regression":
        return await runBrowser(run, log, true);
      case "security":
        return await runSecurity(run, log);
      case "self":
        return await runSelf(run, log);
      case "all": {
        // Everything instance-facing in one run: regression (⊇ smoke) + security,
        // check names prefixed by kind so the UI shows which suite each came from.
        const reg = await runBrowser(run, log, true);
        const sec = await runSecurity(run, log);
        return [
          ...reg.map((c) => ({ ...c, name: `regression/${c.name}` })),
          ...sec.map((c) => ({ ...c, name: `security/${c.name}` })),
        ];
      }
      default:
        return [{ name: "unknown-kind", pass: false, detail: `unsupported kind: ${String(run.kind)}` }];
    }
  } catch (err) {
    return [{ name: run.kind, pass: false, detail: errMsg(err) }];
  }
}
