import { getPrincipal } from "../../../lib/auth";
import {
  listClerkConfigs,
  listInstances,
  type ClerkConfigDoc,
  type InstanceDoc,
} from "../../../lib/models";
import { ClerkClient, type ClerkResp } from "./ClerkClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the Clerk drift / config-template surface (perf-plan
// §Area 3 / P1). It resolves the operator and computes the SAME { configs,
// templates, instances } payload GET /api/clerk returns for the DEFAULT (no
// instanceId) read — straight from the clerkConfigs + instances stores — then hands
// it to the client as SWR fallbackData so first paint is the drift tables instead
// of a blank-then-fetch flash.
//
// SCOPE OF THE SERVER SEED: only the default `/api/clerk` key (the fleet drift list
// + templates + compact instance list). The per-instance live "Read config"
// (`?instanceId=…`) drives Playwright/FAPI and is inherently interactive — it stays
// a client action (a POST/GET mint that fallbackData does not seed). The richer
// `/api/instances` feed the client also reads is left to SWR (own key), same as the
// established Logs/Queue seeds only their own default key.
//
// AUTH GATE PRESERVED: /api/clerk GET floors at withOperator's default read gate
// (any authenticated operator). We prefetch ONLY when getPrincipal() resolves; an
// unauthenticated caller gets no fallback and the client's own /api/clerk GET (401)
// + middleware redirect handle it exactly as before. Only instance ids/names, clerk
// instance hostnames, drift KEY NAMES and timestamps are rendered — never a clerk
// secret/token (mirrors the route's projection; the stored config values themselves
// are not sent by the default GET).
export default async function ClerkPage() {
  let fallback: ClerkResp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      const [all, instances] = await Promise.all([listClerkConfigs(), listInstances()]);
      const annotated = withReferences(all, instances);
      // Same wire shape /api/clerk GET emits (route.ts, no-instanceId branch):
      // per-instance drift rows, wizard templates, and the compact instance list.
      fallback = {
        configs: annotated.filter((c) => !c.template),
        templates: annotated.filter((c) => c.template),
        // clerkInstance is optional on a stored instance; the compact view type
        // widens it to string, so cast across the RSC→client JSON boundary (same
        // bytes SWR would receive — the API emits the raw value, undefined and all).
        instances: instances.map((i) => ({
          id: i.id,
          name: i.name,
          clerkInstance: i.clerkInstance,
        })) as ClerkResp["instances"],
      };
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <ClerkClient fallback={fallback} />;
}

// Annotate each stored config with the live instances that reference its
// clerkInstance — the "which instances use this" signal the hover + detail want.
// Mirrors /api/clerk route.ts withReferences() verbatim so the seed matches the API.
function withReferences(configs: ClerkConfigDoc[], instances: InstanceDoc[]) {
  return configs.map((c) => ({
    ...c,
    usedBy: instances
      .filter((i) => i.clerkInstance && i.clerkInstance === c.clerkInstance)
      .map((i) => ({ id: i.id, name: i.name })),
  }));
}
