// lib/scrub.ts — deterministic, idempotent PII scrub for a Convex snapshot
// export, implemented as a typed, unit-testable module.
//
// It runs BEFORE `convex import` so real PII never lands on the target
// deployment at all (safer than scrubbing in-place after import). Determinism:
// a fresh scrubber maps each distinct person to the SAME scrubbed address
// across every table and every re-run, so re-scrubbing an already-scrubbed
// export is a no-op (idempotent) — the residual-email scan then proves it.
//
// KEEPS, intentionally: changeOrders.foreverId (the legal identity that must
// survive a refresh unchanged) and every financial amount / line-item total.
// See the transform prototype header and the staging-refresh plan Appendix A/B.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ScopedLogger } from "./logtap.ts";

export const DEFAULT_SCRUB_DOMAIN = "staging.example";
// Matches an email-looking substring inside free text (bodies / pasted content).
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

type Row = Record<string, unknown>;

export type TableStat = {
  rows: number;
  emailFields: number;
  phoneFields: number;
  isActiveOff: number;
  pauseHoldCleared: number;
};

export type ScrubReport = {
  ms: number;
  distinctEmails: number;
  perTable: Record<string, TableStat>;
};

export type Scrubber = {
  email(raw: unknown): unknown;
  phone(raw: unknown): unknown;
  freeText(raw: unknown): unknown;
  /** number of distinct originals mapped so far */
  size(): number;
};

/**
 * A fresh, self-contained scrubber. The email map is per-instance so scrubbing
 * is a pure function of input (relationship-preserving + reproducible); reusing
 * one across a whole export keeps the same person consistent everywhere.
 */
export function makeScrubber(scrubDomain = DEFAULT_SCRUB_DOMAIN): Scrubber {
  const emailMap = new Map<string, string>();
  const scrubSuffix = `@${scrubDomain}`;
  // Recognizes an address this scrubber already produced (`u<hex>@<domain>`).
  const alreadyScrubbedEmail = new RegExp(`^u[0-9a-f]+${scrubSuffix.replace(".", "\\.")}$`, "i");
  // Recognizes a phone this scrubber already produced (`+1-555-dddd`).
  const alreadyScrubbedPhone = /^\+1-555-\d{4}$/;

  const email = (raw: unknown): unknown => {
    if (typeof raw !== "string" || !raw.includes("@")) return raw;
    // Idempotency: re-scrubbing an already-scrubbed address is a no-op, so
    // f(f(x)) === f(x) even if the scrub runs twice on the same data.
    if (alreadyScrubbedEmail.test(raw.trim())) return raw;
    const norm = raw.trim().toLowerCase();
    const existing = emailMap.get(norm);
    if (existing) return existing;
    const h = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 10);
    const scrubbed = `u${h}${scrubSuffix}`;
    emailMap.set(norm, scrubbed);
    return scrubbed;
  };

  const phone = (raw: unknown): unknown => {
    if (typeof raw !== "string" || !raw.trim()) return raw;
    if (alreadyScrubbedPhone.test(raw.trim())) return raw; // idempotent no-op
    const h = parseInt(
      crypto.createHash("sha1").update(raw.trim()).digest("hex").slice(0, 8),
      16,
    );
    return `+1-555-${String(h % 10000).padStart(4, "0")}`;
  };

  const freeText = (raw: unknown): unknown => {
    if (typeof raw !== "string") return raw;
    return raw.replace(EMAIL_RE, (m) => email(m) as string);
  };

  return { email, phone, freeText, size: () => emailMap.size };
}

// ── Per-table row transformers ──────────────────────────────────────────────
// Mirrors the prototype field list (derived from a live snapshot enumeration).
// Each returns the mutated row and bumps stats. `s` is the shared Scrubber.
type Transformer = (r: Row, bump: (k: keyof TableStat, n?: number) => void, s: Scrubber) => Row;

export const TRANSFORMERS: Record<string, Transformer> = {
  users(r, bump, s) {
    if (r.email) { r.email = s.email(r.email); bump("emailFields"); }
    if (r.phoneNumber) { r.phoneNumber = s.phone(r.phoneNumber); bump("phoneFields"); }
    // auth remap: authId always becomes pending:<scrubbed-email>. The prod Clerk
    // instance differs from the target's, so the original authId can never match
    // a token here; resetAuthIdsForClonedDeployment enforces the same invariant
    // on the live deployment after import.
    if (r.email) r.authId = `pending:${r.email}`;
    return r;
  },
  accounts(r, bump, s) { if (r.contactEmail) { r.contactEmail = s.email(r.contactEmail); bump("emailFields"); } return r; },
  contacts(r, bump, s) {
    if (r.email) { r.email = s.email(r.email); bump("emailFields"); }
    if (r.phone) { r.phone = s.phone(r.phone); bump("phoneFields"); }
    return r;
  },
  changeOrderStakeholders(r, bump, s) { if (r.externalEmail) { r.externalEmail = s.email(r.externalEmail); bump("emailFields"); } return r; },
  invitations(r, bump, s) { if (r.email) { r.email = s.email(r.email); bump("emailFields"); } return r; },
  organizations(r, bump, s) { if (r.billingEmail) { r.billingEmail = s.email(r.billingEmail); bump("emailFields"); } return r; },
  projectStakeholders(r, bump, s) { if (r.email) { r.email = s.email(r.email); bump("emailFields"); } return r; },
  stakeholderGrants(r, bump, s) { if (r.email) { r.email = s.email(r.email); bump("emailFields"); } return r; },
  scheduledReports(r, bump, s) {
    if (Array.isArray(r.recipientEmails)) {
      r.recipientEmails = (r.recipientEmails as unknown[]).map((e) => s.email(e));
      bump("emailFields", (r.recipientEmails as unknown[]).length);
    }
    // async-neutralize: stop nightlyScheduledReports firing against imported data.
    if (r.isActive !== false) { r.isActive = false; bump("isActiveOff"); }
    return r;
  },
  emailMessages(r, bump, s) {
    if (Array.isArray(r.recipients)) {
      for (const rec of r.recipients as Row[]) {
        if (rec && typeof rec === "object" && rec.email) { rec.email = s.email(rec.email); bump("emailFields"); }
      }
    }
    for (const f of ["htmlBody", "body", "textBody", "subject"]) if (r[f]) r[f] = s.freeText(r[f]);
    return r;
  },
  responseEmails(r, bump, s) { for (const f of ["htmlBody", "body", "subject"]) if (r[f]) r[f] = s.freeText(r[f]); return r; },
  documents(r, bump, s) { if (r.pastedContent) r.pastedContent = s.freeText(r.pastedContent); return r; },
  changeOrders(r, bump) {
    // async-neutralize: stop pauseHoldExpirationWarnings firing on imported
    // pause_hold COs. foreverId + approvedAmount/amount + line-item totals are
    // intentionally left untouched.
    if (r.pauseHoldUntil !== undefined) { delete r.pauseHoldUntil; bump("pauseHoldCleared"); }
    return r;
  },
};

function emptyStat(): TableStat {
  return { rows: 0, emailFields: 0, phoneFields: 0, isActiveOff: 0, pauseHoldCleared: 0 };
}

function transformTableFile(
  table: string,
  src: string,
  dst: string,
  scrubber: Scrubber,
  stats: Record<string, TableStat>,
): void {
  const stat = (stats[table] ??= emptyStat());
  const bump = (k: keyof TableStat, n = 1) => { stat[k] += n; };
  const out: string[] = [];
  for (const line of fs.readFileSync(src, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    stat.rows += 1;
    out.push(JSON.stringify(TRANSFORMERS[table](row, bump, scrubber)));
  }
  fs.writeFileSync(dst, out.join("\n") + (out.length ? "\n" : ""));
}

/**
 * Copy `inDir` → `outDir`, rewriting `<table>/documents.jsonl` for scrubbed
 * tables and copying everything else (including `_storage/`) verbatim. Returns a
 * report; determinism means running it on its own output changes nothing.
 */
export function scrubExportDir(
  inDir: string,
  outDir: string,
  opts: { scrubDomain?: string; log?: ScopedLogger } = {},
): ScrubReport {
  const t0 = Date.now();
  const scrubber = makeScrubber(opts.scrubDomain);
  const stats: Record<string, TableStat> = {};

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const walk = (rel = ""): void => {
    const srcDir = path.join(inDir, rel);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const relPath = path.join(rel, entry.name);
      const src = path.join(inDir, relPath);
      const dst = path.join(outDir, relPath);
      if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(relPath); continue; }
      const table = rel; // parent dir name == table name for */documents.jsonl
      if (entry.name === "documents.jsonl" && TRANSFORMERS[table]) {
        transformTableFile(table, src, dst, scrubber, stats);
      } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  };
  walk();

  const report: ScrubReport = { ms: Date.now() - t0, distinctEmails: scrubber.size(), perTable: stats };
  opts.log?.("info", `scrub complete: ${report.distinctEmails} distinct emails mapped across ${Object.keys(stats).length} tables in ${report.ms}ms`);
  return report;
}

export type ResidualScan = { count: number; samples: string[] };

/**
 * Walk a (scrubbed) export dir and flag any email whose domain is NOT the scrub
 * domain — i.e. a real address that leaked through. The refresh's A-4 verify
 * step exits non-zero when `count > 0`.
 */
export function scanResidualEmails(dir: string, scrubDomain = DEFAULT_SCRUB_DOMAIN): ResidualScan {
  let count = 0;
  const samples: string[] = [];
  const suffix = `@${scrubDomain}`;
  const scan = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (e.name !== "documents.jsonl") continue;
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        for (const m of line.matchAll(EMAIL_RE)) {
          if (!m[0].toLowerCase().endsWith(suffix)) {
            count++;
            if (samples.length < 10) samples.push(`${path.relative(dir, p)}: ${m[0]}`);
          }
        }
      }
    }
  };
  scan(dir);
  return { count, samples };
}
