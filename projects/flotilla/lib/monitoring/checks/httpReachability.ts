import net from "node:net";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { MAX_CHECK_TIMEOUT_MS } from "../../models/monitoring/types.ts";
import type { CheckOutcome, CheckType } from "./types.ts";

// http_reachability — GET a URL and assert it is reachable / returns an expected
// status (design §3.2). Observe-only + bounded: GET only, honors the per-check
// AbortSignal, no redirects followed off-host, a network error/timeout yields
// UNKNOWN (not CRIT — we couldn't determine it). A non-matching status is CRIT
// (or WARN per `severity`). The URL is EITHER the target's own instance URL (for
// instance selectors) or the operator-provided `url` (url selector / explicit
// param) — an operator is write-gated, so param URLs are trusted at that tier.
export const httpReachabilityParams = z
  .object({
    // Explicit URL. Required when the target is not an instance and not a url
    // selector (validated at run-time; the create schema can't know the target).
    url: z.string().trim().url().max(500).optional(),
    // Path appended to an instance target's own URL (e.g. "/" or "/health").
    path: z.string().trim().max(200).default("/"),
    // Exact expected status. Omitted ⇒ any 2xx/3xx is OK.
    expectStatus: z.number().int().min(100).max(599).optional(),
    timeoutMs: z.number().int().min(500).max(MAX_CHECK_TIMEOUT_MS).default(10_000),
    severity: z.enum(["warn", "crit"]).default("crit"),
  })
  .strict();

// Resolve the URL to hit from the target + params. Instance targets derive it from
// their own known URL (+ path); a url target uses its literal; otherwise the
// explicit param URL. Returns null when none is determinable.
function resolveUrl(
  target: { kind: string; url?: string; instance?: { url?: string } },
  p: z.infer<typeof httpReachabilityParams>,
): string | null {
  if (target.kind === "url" && target.url) return target.url;
  if (target.kind === "instance" && target.instance?.url) {
    const base = target.instance.url.replace(/\/+$/, "");
    const path = p.path.startsWith("/") ? p.path : `/${p.path}`;
    return `${base}${path}`;
  }
  return p.url ?? null;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
// A custom-`url` target is operator-supplied, but "operator write-gated" does NOT
// mean the URL is safe to fetch: it could point (directly or via DNS) at loopback,
// RFC-1918 private space, link-local, or the cloud metadata endpoint
// (169.254.169.254) — an SSRF pivot from this server. So for CUSTOM urls we resolve
// the host and refuse any private/internal address BEFORE fetching. Instance targets
// (the instance's own known URL) are exempt — that's the whole point of the feature.

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // drop any zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  return false;
}

function isBlockedAddress(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

// True when `rawUrl`'s host is — or DNS-resolves to — a loopback/private/link-local/
// metadata address, or the literal `localhost`. Unparseable URL ⇒ blocked (don't
// fetch). Unresolvable host ⇒ NOT blocked (let the fetch fail as an honest UNKNOWN;
// a resolution failure is not an SSRF signal).
export async function isBlockedHost(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return true;
  }
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase(); // strip IPv6 [] brackets
  if (bare === "localhost" || bare === "localhost.localdomain" || bare.endsWith(".localhost")) return true;
  if (net.isIP(bare)) return isBlockedAddress(bare);
  try {
    const results = await lookup(bare, { all: true });
    return results.some((r) => isBlockedAddress(r.address));
  } catch {
    return false;
  }
}

export const httpReachabilityCheck: CheckType = {
  id: "http_reachability",
  label: "HTTP reachability",
  targetKinds: ["instance", "url"],
  selectorKinds: ["instance", "instanceType", "all", "url"],
  params: httpReachabilityParams,
  async run(ctx): Promise<CheckOutcome> {
    const p = httpReachabilityParams.parse(ctx.params);
    const url = resolveUrl(ctx.target, p);
    if (!url) {
      return { status: "unknown", output: "no URL to check (no instance URL and no `url` param)", error: "no url" };
    }
    // SSRF guard — CUSTOM url targets only (kind !== "instance"). An instance target
    // hits its own managed URL and is trusted; a custom/url-selector target is not.
    if (ctx.target.kind !== "instance" && (await isBlockedHost(url))) {
      return {
        status: "unknown",
        output: "blocked: private/internal address not allowed for custom URL targets",
        error: "blocked host",
      };
    }
    // Bound the fetch by the SMALLER of the check budget (ctx.signal) and the
    // per-request timeout. Compose both signals so either aborts the fetch.
    const local = AbortSignal.timeout(p.timeoutMs);
    const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([ctx.signal, local]) : local;
    const started = ctx.now;
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal });
      const ms = Date.now() - started;
      const okStatus =
        p.expectStatus !== undefined
          ? res.status === p.expectStatus
          : res.status >= 200 && res.status < 400;
      const want = p.expectStatus !== undefined ? `==${p.expectStatus}` : "2xx/3xx";
      const output = `GET ${url} → ${res.status} (${ms}ms), want ${want} → ${okStatus ? "ok" : p.severity}`;
      return { status: okStatus ? "ok" : p.severity, output, value: res.status };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: "unknown", output: `GET ${url} failed: ${reason}`, error: reason };
    }
  },
};
