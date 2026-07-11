import { ok, bad } from "@/lib/api";
import { getFeatureFlags } from "@/lib/models";
import { verifyGithubSignature } from "@/lib/clients/github";
import { parsePullRequestEvent, handlePullRequestEvent } from "@/lib/prLifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/webhooks/github — the PR-native lifecycle ingress (feature #1 + #2).
//
// AUTH IS DIFFERENT HERE: GitHub is the caller, not a dashboard operator, so this
// route is the ONE route that does NOT run through withOperator. Its authentication
// is the GitHub webhook HMAC signature (X-Hub-Signature-256) verified against
// GITHUB_WEBHOOK_SECRET — we NEVER provision from an unverified payload. It also
// no-ops entirely when the `prNativeLifecycle` feature flag is off.
//
// It validates + enqueues + returns fast; provisioning/refresh/teardown run as jobs
// on the worker (via the same enqueue verbs as an operator launch, so the executor's
// prod/shared preflight guards apply identically). Idempotent: one instance per PR.
export async function POST(req: Request) {
  // Raw body FIRST — the HMAC is computed over the exact bytes GitHub sent.
  const raw = await req.text();

  // Flag gate: default OFF. When off the route does nothing (and does not even
  // require a valid signature) — it is inert until an operator turns it on.
  let enabled = false;
  try {
    enabled = (await getFeatureFlags()).prNativeLifecycle;
  } catch {
    enabled = false; // config store down → stay inert, never fail open
  }
  if (!enabled) return ok({ skipped: "prNativeLifecycle feature is disabled" });

  // Signature verification — reject anything we can't authenticate.
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !secret.trim()) {
    // Misconfiguration, not the caller's fault — 503 so GitHub retries after the
    // operator sets the secret, and we never fall open.
    return bad("webhook secret not configured", 503);
  }
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyGithubSignature(raw, signature, secret)) {
    return bad("invalid or missing signature", 401);
  }

  const eventType = req.headers.get("x-github-event") ?? "";
  if (eventType === "ping") return ok({ pong: true });
  if (eventType !== "pull_request") return ok({ ignored: eventType || "unknown-event" });

  // Parse the verified payload.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return bad("invalid JSON payload");
  }
  const event = parsePullRequestEvent(payload);
  if (!event) return bad("not a recognizable pull_request payload");

  try {
    const result = await handlePullRequestEvent(event);
    return ok({ ...result });
  } catch (err) {
    // Never leak internals to the caller; log server-side.
    console.error("[webhooks/github] handler error", err);
    return bad("internal error", 500);
  }
}
