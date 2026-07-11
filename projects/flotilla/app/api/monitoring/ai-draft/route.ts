import { z } from "zod";
import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, getInstance, recordAudit } from "@/lib/models";
import { draftMonitor, type DraftInstanceContext } from "@/lib/monitoring/aiDraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/monitoring/ai-draft — the AI MONITOR-SETUP helper (Phase 4, §9.2).
//
// Given a natural-language request (+ optional target instance), a tool-forced
// Anthropic call returns an INERT DRAFT monitor constrained to the CLOSED check-type
// registry and validated against the SAME schema the create route uses. It does NOT
// create the monitor — the operator reviews the draft and confirms it via the
// ordinary POST /api/monitoring/monitors create path (re-validated server-side).
//
// Gated in layers (drafting is a write-tier assist — it incurs AI spend and is the
// setup step for a write action, so `write`, not `read-only`):
//   1. operator auth + write role (withOperator "write")
//   2. monitoring feature flag (403 when off)
//   3. ANTHROPIC_API_KEY — degrades cleanly (the helper returns configured:false,
//      draft:null, no model call) rather than erroring, so the UI shows a note.
// Every draft request is stamped in the audit trail (who asked for a draft).
//
//   POST { request, instanceId?, page? } → { draft, rationale, warnings, canDraft, ... }
const Body = z.object({
  request: z.string().trim().min(1, "request is required").max(2000),
  // Optional grounding: the instance the operator is looking at when drafting.
  instanceId: z.string().trim().max(120).optional(),
  // Current route/page, recorded for attribution only.
  page: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);

    const { request, instanceId } = Body.parse(await req.json().catch(() => ({})));

    // Load the optional target instance context (best-effort — a missing instance
    // just means no grounding, not an error).
    let ctx: DraftInstanceContext | undefined;
    if (instanceId) {
      const inst = await getInstance(instanceId).catch(() => null);
      if (inst) ctx = { id: inst.id, name: inst.name, kind: inst.kind, url: inst.url, branch: inst.branch };
    }

    // Attribution: record WHO asked for a draft (not the full answer). Best-effort —
    // a failed audit write must never break the response.
    await recordAudit(principal.id, "monitoring.ai.draft", instanceId ?? "(fleet)", request.slice(0, 120)).catch(() => {});

    // The helper degrades cleanly (returns configured:false) when AI isn't set up.
    const result = await draftMonitor(request, ctx);
    return ok({ ...result });
    // write: drafting is the setup step for a create AND incurs AI spend, so it is
    // write-tier — but the draft itself is INERT. The authorization to actually
    // create the monitor is the ordinary write-gated create route, not this prompt.
  }, "write");
}
