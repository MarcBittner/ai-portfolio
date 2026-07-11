// lib/deployments.ts — SINGLE SOURCE OF TRUTH for the managed Convex deployment
// topology. The values are environment-overridable but ship with baked defaults so
// (a) the safety guards stay fail-safe when unconfigured, and (b) client components
// (which cannot read server-only env at runtime) still render the picker lists.
//
// SAFETY: the primary overwrite guard is the explicit `dangerAck` required on EVERY
// write to a pre-existing deployment (see lib/executor.ts preflight); it is
// INDEPENDENT of this table. This table adds defense-in-depth — the PRODUCTION hard
// write/teardown block (no ack can override it) and the shared-deployment warnings —
// so keep FLOTILLA_PROD_CONVEX_DEPLOYMENT correct in every environment.
//
// Server-side overrides (client bundles fall back to the baked defaults):
//   FLOTILLA_PROD_CONVEX_DEPLOYMENT  — the production deployment name (hard block)
//   FLOTILLA_SHARED_DEPLOYMENTS      — "name:role,name:role" guard map (danger-gated)

export type ManagedDeployment = { id: string; label: string };

// Baked defaults — a GENERIC example fleet topology (override per-deploy via the env
// vars below). Roles are load-bearing: "PRODUCTION" / "staging-prod" force PII
// masking + gate the prod-data guards. The names are neutral placeholders — set
// FLOTILLA_PROD_CONVEX_DEPLOYMENT / FLOTILLA_SHARED_DEPLOYMENTS to your real fleet.
const DEFAULT_PROD = "demo-prod";
const DEFAULT_SHARED: Record<string, string> = {
  "demo-prod": "PRODUCTION",
  "demo-staging-prod": "staging-prod",
  "demo-ci": "ci",
  "demo-dev": "dev",
  "demo-staging-dev": "staging-dev",
};
// The backups/dashboard picker list (short labels + order preserved for the UI).
const DEFAULT_MANAGED: ManagedDeployment[] = [
  { id: "demo-prod", label: "prod" },
  { id: "demo-staging-prod", label: "staging-prod" },
  { id: "demo-ci", label: "ci" },
  { id: "demo-dev", label: "dev" },
];

function parseSharedEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    const name = (i === -1 ? pair : pair.slice(0, i)).trim();
    const role = (i === -1 ? "shared" : pair.slice(i + 1)).trim() || "shared";
    if (name) out[name] = role;
  }
  return out;
}

/** The production deployment — a HARD, non-ackable write/teardown target. */
export const PROD_CONVEX_DEPLOYMENT: string =
  process.env.FLOTILLA_PROD_CONVEX_DEPLOYMENT?.trim() || DEFAULT_PROD;

/** name -> role label for the shared/managed deployments (danger-gated). */
export const SHARED_DEPLOYMENTS: Record<string, string> =
  process.env.FLOTILLA_SHARED_DEPLOYMENTS
    ? parseSharedEnv(process.env.FLOTILLA_SHARED_DEPLOYMENTS)
    : DEFAULT_SHARED;

/** The managed picker list (id + short label) for the backups/dashboard UIs. */
export const MANAGED_DEPLOYMENTS: readonly ManagedDeployment[] =
  process.env.FLOTILLA_SHARED_DEPLOYMENTS
    ? Object.entries(SHARED_DEPLOYMENTS).map(([id, role]) => ({
        id,
        label: id === PROD_CONVEX_DEPLOYMENT ? "prod" : role,
      }))
    : DEFAULT_MANAGED;

/** First deployment name carrying `role`, or "" if none is configured. */
export function deploymentByRole(role: string): string {
  for (const [id, r] of Object.entries(SHARED_DEPLOYMENTS)) if (r === role) return id;
  return "";
}

export function isProdDeployment(dep?: string | null): boolean {
  return !!dep && dep === PROD_CONVEX_DEPLOYMENT;
}
export function isSharedDeployment(dep?: string | null): boolean {
  return !!dep && Object.prototype.hasOwnProperty.call(SHARED_DEPLOYMENTS, dep);
}
/** prod or staging-prod — the "cause a stir" surface the dashboard flags red. */
export function isSensitiveDeployment(dep?: string | null): boolean {
  return isProdDeployment(dep) || SHARED_DEPLOYMENTS[dep ?? ""] === "staging-prod";
}
