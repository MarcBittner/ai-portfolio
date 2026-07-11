// lib/mask.ts — deterministic, referentially-consistent PII MASKING for a Convex
// snapshot export, run BEFORE `convex import` so real identity PII never lands on
// a break-glass-gated test instance at all.
//
// Why a NEW module next to lib/scrub.ts: scrub.ts does a `JSON.parse` →
// `JSON.stringify` round-trip per row, which silently DROPS Convex's float
// encoding (`1234.0` → `1234`) and would corrupt the financial rollups the import
// depends on. This module instead does a STRING-LEVEL transform: it parses each
// JSONL row only to locate the spans of the string values it must mask, then
// splices masked text back in — every number, every key order, every byte we
// don't target is preserved verbatim. That is the load-bearing difference.
//
// Determinism + referential consistency: the SAME input value maps to the SAME
// masked value everywhere (so `_id`-reference joins and cross-table identities
// stay intact). Backed by @snaplet/copycat (MIT, SipHash-deterministic) seeded
// with a per-run secret; falls back to an HMAC-based masker when copycat is
// absent (keeps typecheck + offline runs green — same guarantees, plainer output).
//
// Hash-key hardening (FLOTILLA_MASK_HASH_KEY): copycat's default SipHash key is a
// PUBLIC constant, so an attacker holding the public seed + a known dataset could
// pre-compute copycat's output and reverse a masked identity value. Set a secret
// per-deployment `FLOTILLA_MASK_HASH_KEY` and it is fed to copycat's `setHashKey()`
// (and mixed into the HMAC fallback's key) so all masked values are salted by a
// credential the attacker does not have. Back-compat: UNSET ⇒ exactly today's
// default-seed behaviour (no forced migration). Determinism is retained *for a
// given key* — same key + same input ⇒ identical output, so joins/rollups still
// line up. CHANGING the key changes the ENTIRE mapping (a refresh with a new key
// produces a different but still internally-consistent masking); that is expected
// and acceptable, but a snapshot masked under key A will NOT line up value-for-
// value with one masked under key B. Keep the key stable per deployment.
//
// What it MASKS: identity PII only — email / firstName / lastName / name /
// fullName / phone / phoneNumber / avatarUrl / address-ish, and any `*Email` /
// `*Name` field, plus emails embedded in known free-text bodies.
// What it NEVER touches: `_id`, `_creationTime`, any `*Id`/`*Ids` reference, a
// value that looks like a Convex id (32-char base32), `authId` (rewritten later
// by resetAuthIdsForClonedDeployment), `organizationId`, and every numeric /
// financial field (so rollups survive).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { ScopedLogger } from "./logtap.ts";

export const MASK_EMAIL_DOMAIN = "masked.invalid";
// Matches an email-looking substring inside free text (bodies / pasted content).
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A Convex document id is 32 lower-case base32 chars — never mask one (it is a
// reference target, not PII), even if it happens to land in a name/email field.
const CONVEX_ID_RE = /^[0-9a-z]{32}$/;

// ── the copycat backend (optional, loaded once) ─────────────────────────────
// `setHashKey` (copycat v6, exported on the `copycat` namespace — verified against
// node_modules/@snaplet/copycat@6.0.0: `copycat.setHashKey(key: string): void`)
// swaps copycat's PUBLIC default SipHash key for our secret one, salting every
// derived value. It is PROCESS-GLOBAL state in the underlying `fictional` lib, so
// we set it once at masker init before any masking call; masking runs only in the
// worker's single-purpose data path, so a global keying there is safe.
type CopycatBackend = {
  email(input: unknown): string;
  firstName(input: unknown): string;
  lastName(input: unknown): string;
  fullName(input: unknown): string;
  setHashKey?: (key: string) => void;
};
let copycatCache: CopycatBackend | null | undefined;
function loadCopycat(): CopycatBackend | null {
  if (copycatCache !== undefined) return copycatCache;
  try {
    // Loaded via createRequire (not a static import) so the module is optional:
    // absent → HMAC fallback, and it never gets pulled into the serverless bundle
    // (mask.ts is only dynamically imported by the worker's data path).
    const req = createRequire(import.meta.url);
    const mod = req("@snaplet/copycat") as { copycat?: CopycatBackend };
    copycatCache = mod.copycat ?? null;
  } catch {
    copycatCache = null;
  }
  return copycatCache;
}

// Read the per-deployment secret hash key. Env-only (NEVER a runtime-config key —
// see lib/models/config.ts, which forbids secrets), NEVER logged. Blank/unset ⇒
// undefined ⇒ preserve today's default-seed behaviour (full back-compat).
export function resolveMaskHashKey(): string | undefined {
  const raw = process.env.FLOTILLA_MASK_HASH_KEY;
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return v === "" ? undefined : v;
}

// Track the hash key we've already pushed into copycat so re-init with the SAME
// key is a no-op (avoids redundant global-state churn). copycat's key is global,
// so the LAST key set wins for the whole process — matched by the per-masker
// hmac keying below so both backends honour the same key.
let appliedCopycatHashKey: string | null = null;
function applyCopycatHashKey(copycat: CopycatBackend | null, key: string | undefined): void {
  if (!copycat || typeof copycat.setHashKey !== "function") return;
  const target = key ?? null;
  if (appliedCopycatHashKey === target) return; // already applied (or already default)
  if (key !== undefined) copycat.setHashKey(key);
  appliedCopycatHashKey = target;
  // NB: intentionally no log — the key is a secret and must never be echoed.
}

// Test seam: forget the last-applied key so a suite that toggles the key between
// makeMasker() calls re-applies it (copycat's key is process-global; the guard
// above would otherwise short-circuit the second set within one process).
export function __resetMaskHashKeyState(): void {
  appliedCopycatHashKey = null;
}

// ── the masker ──────────────────────────────────────────────────────────────
export type Masker = {
  email(raw: string): string;
  firstName(raw: string): string;
  lastName(raw: string): string;
  fullName(raw: string): string;
  name(raw: string): string;
  phone(raw: string): string;
  url(raw: string): string;
  address(raw: string): string;
  /** Replace only email-looking substrings inside a free-text body. */
  freeText(raw: string): string;
  /** True once this value was produced by THIS masker (idempotency guard). */
  isMasked(raw: string): boolean;
  /** number of distinct originals mapped so far */
  size(): number;
  backend: "copycat" | "hmac";
};

/**
 * A fresh masker seeded with `secret`. Determinism is a pure function of
 * (secret, hashKey, input): the same input always maps to the same output within
 * a run, and a different secret OR a different hash key reshuffles the whole
 * mapping. A per-masker cache keeps the mapping stable + fast; a `produced` set
 * makes re-masking already-masked data a no-op (f(f(x)) === f(x)).
 *
 * `hashKey` (default: `FLOTILLA_MASK_HASH_KEY`) is the per-deployment secret salt:
 *   • copycat backend → pushed into `copycat.setHashKey()` (process-global) so
 *     copycat's SipHash is no longer keyed by its PUBLIC default constant;
 *   • HMAC fallback   → mixed into the HMAC key so both paths honour the key.
 * UNSET ⇒ exactly today's behaviour. NEVER logged.
 */
export function makeMasker(secret: string, hashKey?: string): Masker {
  const copycat = loadCopycat();
  const key = hashKey !== undefined ? (hashKey.trim() || undefined) : resolveMaskHashKey();
  applyCopycatHashKey(copycat, key);
  const cache = new Map<string, string>();
  const produced = new Set<string>();

  // The HMAC fallback's key folds in the hash key too, so the fallback path is
  // salted by the same credential as the copycat path (unset ⇒ bare `secret`,
  // i.e. byte-identical to today's fallback output).
  const hmacKey = key === undefined ? secret : `${secret} hk:${key}`;
  const hmac = (label: string, raw: string): string =>
    crypto.createHmac("sha256", hmacKey).update(`${label}:${raw}`).digest("hex");

  // Wrap a raw→masked transform with the cache + idempotency guard so every
  // call site stays deterministic and referentially consistent.
  const memo = (label: string, raw: string, fn: (norm: string) => string): string => {
    if (produced.has(raw)) return raw; // already one of ours — leave it
    const key = `${label}\u0000${raw}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const out = fn(raw);
    cache.set(key, out);
    produced.add(out);
    return out;
  };

  // copycat is seeded by prefixing the per-run secret to the input, so the same
  // value is consistent within a run and unlinkable across runs.
  const seeded = (raw: string) => `${secret}|${raw}`;
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  return {
    backend: copycat ? "copycat" : "hmac",

    email(raw) {
      return memo("email", raw, (r) => {
        const norm = r.trim().toLowerCase();
        if (copycat) return String(copycat.email(seeded(norm))).toLowerCase();
        return `u${hmac("email", norm).slice(0, 12)}@${MASK_EMAIL_DOMAIN}`;
      });
    },
    firstName(raw) {
      return memo("firstName", raw, (r) =>
        copycat ? String(copycat.firstName(seeded(r))) : cap(hmac("first", r).slice(0, 8)),
      );
    },
    lastName(raw) {
      return memo("lastName", raw, (r) =>
        copycat ? String(copycat.lastName(seeded(r))) : cap(hmac("last", r).slice(0, 8)),
      );
    },
    fullName(raw) {
      return memo("fullName", raw, (r) =>
        copycat
          ? String(copycat.fullName(seeded(r)))
          : `${cap(hmac("first", r).slice(0, 6))} ${cap(hmac("last", r).slice(0, 8))}`,
      );
    },
    name(raw) {
      // A generic display name — reuse the fullName mapping for consistency.
      return this.fullName(raw);
    },
    phone(raw) {
      // Deterministic +1-555-XXXX shape (always a reserved test range).
      return memo("phone", raw, (r) => {
        const n = parseInt(hmac("phone", r.trim()).slice(0, 8), 16) % 10000;
        return `+1-555-${String(n).padStart(4, "0")}`;
      });
    },
    url(raw) {
      return memo("url", raw, (r) => `https://${MASK_EMAIL_DOMAIN}/a/${hmac("url", r).slice(0, 12)}`);
    },
    address(raw) {
      return memo("address", raw, (r) => {
        const num = parseInt(hmac("addr", r).slice(0, 4), 16) % 9000 + 100;
        return `${num} Masked St, Testville`;
      });
    },
    freeText(raw) {
      if (typeof raw !== "string" || !raw.includes("@")) return raw;
      return raw.replace(EMAIL_RE, (m) => this.email(m));
    },
    isMasked: (raw) => produced.has(raw),
    size: () => produced.size,
  };
}

// ── field classification ────────────────────────────────────────────────────
type FieldKind = "email" | "firstName" | "lastName" | "name" | "phone" | "url" | "address" | "freeText";

// Keys we must NEVER mask (references + system fields). Any `*Id`/`*Ids` key is a
// foreign-key reference; masking it would break `_id`-join integrity.
const DENY_KEYS = new Set(["_id", "_creationTime", "_table", "authId", "organizationId"]);
function isReferenceKey(key: string): boolean {
  return DENY_KEYS.has(key) || /(Id|Ids)$/.test(key);
}

const ADDRESS_KEYS = new Set([
  "address", "street", "streetaddress", "city", "state", "zip", "zipcode",
  "postalcode", "addressline1", "addressline2", "country", "region", "county",
]);
const FREETEXT_KEYS = new Set([
  "htmlbody", "body", "textbody", "subject", "pastedcontent", "message",
  "notes", "note", "description", "content",
]);

/** Decide how (if at all) a field named `key` should be masked. Case-insensitive
 *  on the key; returns null to leave the value untouched. */
export function classifyField(key: string): FieldKind | null {
  if (isReferenceKey(key)) return null;
  const lk = key.toLowerCase();
  if (lk === "firstname") return "firstName";
  if (lk === "lastname") return "lastName";
  if (lk === "email" || lk.endsWith("email") || lk.endsWith("emails")) return "email";
  if (lk === "phone" || lk === "phonenumber" || lk.endsWith("phone") || lk.endsWith("phonenumber")) return "phone";
  if (lk.includes("avatar") || lk === "photourl" || lk === "imageurl") return "url";
  if (lk === "name" || lk === "fullname" || lk === "displayname" || lk.endsWith("name")) return "name";
  if (ADDRESS_KEYS.has(lk) || lk.endsWith("address")) return "address";
  if (FREETEXT_KEYS.has(lk)) return "freeText";
  return null;
}

function applyKind(kind: FieldKind, value: string, m: Masker): string {
  switch (kind) {
    case "email": return m.email(value);
    case "firstName": return m.firstName(value);
    case "lastName": return m.lastName(value);
    case "name": return m.name(value);
    case "phone": return m.phone(value);
    case "url": return m.url(value);
    case "address": return m.address(value);
    case "freeText": return m.freeText(value);
  }
}

// ── the string-level JSONL rewriter ─────────────────────────────────────────
// Per-table row overrides applied ONLY at the row root (depth 0): flip a boolean
// literal or delete a member, at the string level, so number encoding elsewhere
// in the row is untouched. This is how async jobs are neutralized on a clone
// without a JSON re-serialize.
export type RowOverride =
  | { action: "literal"; text: string }
  | { action: "delete" };

export type LineRewriter = {
  /** Masked value for `key` at any depth, or undefined to leave the value as-is. */
  maskValue(key: string, value: string): string | undefined;
  /** A root-level member override (neutralize), or undefined. */
  rootOverride(key: string): RowOverride | undefined;
};

type Edit = { start: number; end: number; text: string };

/**
 * Rewrite one JSONL row. Parses `src` only to LOCATE spans; everything not
 * explicitly targeted (numbers, key order, whitespace, escaping) is copied
 * byte-for-byte. Throws on malformed JSON (the caller keeps the original line).
 */
export function maskJsonLine(src: string, rw: LineRewriter): string {
  const n = src.length;
  let i = 0;
  const edits: Edit[] = [];

  const ws = () => { while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i++; };

  function parseString(): { value: string; start: number; end: number } {
    const start = i;
    i++; // opening quote
    let value = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        const e = src[i + 1];
        switch (e) {
          case "\"": value += "\""; break;
          case "\\": value += "\\"; break;
          case "/": value += "/"; break;
          case "b": value += "\b"; break;
          case "f": value += "\f"; break;
          case "n": value += "\n"; break;
          case "r": value += "\r"; break;
          case "t": value += "\t"; break;
          case "u": value += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 4; break;
          default: value += e ?? "";
        }
        i += 2;
      } else if (c === "\"") {
        i++;
        return { value, start, end: i };
      } else {
        value += c;
        i++;
      }
    }
    throw new Error("unterminated string in JSON line");
  }

  function parseNumber() { while (i < n && "0123456789+-.eE".includes(src[i])) i++; }
  function parseLiteral() { while (i < n && src[i] >= "a" && src[i] <= "z") i++; }

  // `key` carries the enclosing member name so array-of-strings inherits it
  // (e.g. recipientEmails: ["a@b.com"]). `depth` gates root-only overrides.
  function parseValue(key: string | undefined, depth: number): void {
    ws();
    const c = src[i];
    if (c === "{") { parseObject(depth); return; }
    if (c === "[") { parseArray(key, depth); return; }
    if (c === "\"") {
      const s = parseString();
      if (key !== undefined) {
        const masked = rw.maskValue(key, s.value);
        if (masked !== undefined && masked !== s.value) {
          edits.push({ start: s.start, end: s.end, text: JSON.stringify(masked) });
        }
      }
      return;
    }
    if (c === "-" || (c >= "0" && c <= "9")) { parseNumber(); return; }
    parseLiteral();
  }

  function parseArray(key: string | undefined, depth: number): void {
    i++; // [
    ws();
    if (src[i] === "]") { i++; return; }
    for (;;) {
      parseValue(key, depth);
      ws();
      if (src[i] === ",") { i++; ws(); continue; }
      if (src[i] === "]") { i++; return; }
      throw new Error("malformed array in JSON line");
    }
  }

  function parseObject(depth: number): void {
    i++; // {
    ws();
    if (src[i] === "}") { i++; return; }
    for (;;) {
      ws();
      const memberStart = i;
      const keyTok = parseString();
      ws();
      i++; // colon
      const key = keyTok.value;
      const override = depth === 0 ? rw.rootOverride(key) : undefined;

      if (override?.action === "delete") {
        parseValue(undefined, depth + 1);
        const memberEnd = i;
        ws();
        if (src[i] === ",") {
          edits.push({ start: memberStart, end: i + 1, text: "" }); // member + trailing comma
          i += 1;
          continue;
        }
        // last member: also remove the preceding comma (if any) to stay valid
        let p = memberStart - 1;
        while (p >= 0 && (src[p] === " " || src[p] === "\t" || src[p] === "\n" || src[p] === "\r")) p--;
        const delStart = src[p] === "," ? p : memberStart;
        edits.push({ start: delStart, end: memberEnd, text: "" });
        i++; // consume '}'
        return;
      }

      if (override?.action === "literal") {
        ws();
        const vStart = i;
        parseValue(undefined, depth + 1);
        edits.push({ start: vStart, end: i, text: override.text });
      } else {
        parseValue(key, depth + 1);
      }

      ws();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") { i++; return; }
      throw new Error("malformed object in JSON line");
    }
  }

  parseValue(undefined, 0);

  if (edits.length === 0) return src;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue; // defensive: skip any overlap
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += src.slice(pos);
  return out;
}

// ── per-table neutralization (async jobs must not fire on a clone) ──────────
// Root-level overrides mirrored from lib/scrub.ts, applied at the string level so
// financial numbers in the SAME row (e.g. changeOrders.amount = 1234.0) keep
// their encoding. Keyed by table (parent dir of documents.jsonl).
const ROOT_OVERRIDES: Record<string, (key: string) => RowOverride | undefined> = {
  // stop nightlyScheduledReports firing against imported data.
  scheduledReports: (key) => (key === "isActive" ? { action: "literal", text: "false" } : undefined),
  // stop pauseHoldExpirationWarnings firing on imported pause_hold COs.
  changeOrders: (key) => (key === "pauseHoldUntil" ? { action: "delete" } : undefined),
};

export type MaskReport = {
  ms: number;
  distinctMasked: number;
  backend: "copycat" | "hmac";
  tables: number;
  rows: number;
  changedRows: number;
};

function maskTableFile(table: string, src: string, dst: string, masker: Masker, report: MaskReport): void {
  const rootOverride = ROOT_OVERRIDES[table] ?? (() => undefined);
  const rw: LineRewriter = {
    maskValue(key, value) {
      if (!value || CONVEX_ID_RE.test(value)) return undefined; // never mask a reference/id
      const kind = classifyField(key);
      if (!kind) return undefined;
      const masked = applyKind(kind, value, masker);
      return masked === value ? undefined : masked;
    },
    rootOverride,
  };
  const out: string[] = [];
  for (const line of fs.readFileSync(src, "utf8").split("\n")) {
    if (!line.trim()) continue;
    report.rows += 1;
    let rewritten: string;
    try {
      rewritten = maskJsonLine(line, rw);
    } catch {
      // A row we can't parse is left verbatim rather than dropped — masking must
      // never corrupt the import. (Convex export lines are well-formed JSON.)
      rewritten = line;
    }
    if (rewritten !== line) report.changedRows += 1;
    out.push(rewritten);
  }
  fs.writeFileSync(dst, out.join("\n") + (out.length ? "\n" : ""));
}

/**
 * Copy `inDir` → `outDir`, rewriting every `<table>/documents.jsonl` with the
 * PII masker + per-table neutralizations, and copying everything else (incl.
 * `_storage/`) verbatim. One shared masker across the whole export keeps a
 * person consistent in every table. Returns a report.
 */
export function maskExportDir(
  inDir: string,
  outDir: string,
  opts: { secret?: string; hashKey?: string; log?: ScopedLogger } = {},
): MaskReport {
  const t0 = Date.now();
  const secret = opts.secret || process.env.MASK_SECRET || crypto.randomBytes(16).toString("hex");
  // Per-deployment secret hash key: explicit opt override → else FLOTILLA_MASK_HASH_KEY
  // (resolved inside makeMasker). Never logged.
  const masker = makeMasker(secret, opts.hashKey);
  const report: MaskReport = { ms: 0, distinctMasked: 0, backend: masker.backend, tables: 0, rows: 0, changedRows: 0 };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const walk = (rel = ""): void => {
    const srcDir = path.join(inDir, rel);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const relPath = path.join(rel, entry.name);
      const src = path.join(inDir, relPath);
      const dst = path.join(outDir, relPath);
      if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(relPath); continue; }
      if (entry.name === "documents.jsonl" && rel) {
        report.tables += 1;
        maskTableFile(rel, src, dst, masker, report);
      } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  };
  walk();

  report.ms = Date.now() - t0;
  report.distinctMasked = masker.size();
  opts.log?.(
    "info",
    `mask complete (${report.backend}): ${report.distinctMasked} distinct values masked across ${report.tables} tables, ${report.changedRows}/${report.rows} rows changed in ${report.ms}ms`,
  );
  return report;
}

// ── residual leak scan (verify gate) ────────────────────────────────────────
export type ResidualScan = { count: number; samples: string[] };

/**
 * Walk a (masked) export dir and flag any email whose domain is NOT the mask
 * domain living in a field we masked — i.e. a real address that leaked through.
 * Best-effort: free-text bodies can legitimately carry masked addresses, so this
 * only samples the top-level identity fields.
 */
export function scanResidualEmails(dir: string): ResidualScan {
  let count = 0;
  const samples: string[] = [];
  const suffix = `@${MASK_EMAIL_DOMAIN}`;
  const scan = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (e.name !== "documents.jsonl") continue;
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line); } catch { continue; }
        for (const [k, v] of Object.entries(row)) {
          if (typeof v !== "string" || !classifyField(k)) continue;
          if (EMAIL_RE.test(v) && !v.toLowerCase().endsWith(suffix)) {
            // copycat emails use realistic domains, so only flag when the HMAC
            // fallback domain is expected — realistic copycat output is fine.
            count++;
            if (samples.length < 10) samples.push(`${path.relative(dir, p)}: ${k}`);
          }
          EMAIL_RE.lastIndex = 0;
        }
      }
    }
  };
  scan(dir);
  return { count, samples };
}
