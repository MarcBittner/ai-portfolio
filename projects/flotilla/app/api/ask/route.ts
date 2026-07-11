import { z } from "zod";
import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, recordAudit } from "@/lib/models";
import { askAi } from "@/lib/aiRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/ask — the global "Ask AI" assistant endpoint. READ-ONLY: it answers
// questions ABOUT the dashboard; it never acts. Gated in layers:
//   1. operator auth (withOperator)
//   2. askAi feature flag (403 when off)
// It then routes through the config-selected provider/chain (lib/aiRouter.ts),
// which never throws to the client — it always returns an answer (falling back to
// the deterministic keyword map). API keys stay server-side and are never exposed.
//
//   POST { question, page? } -> { answer, provider, fellBackFrom? }

const AskBody = z.object({
  question: z.string().trim().min(1, "question is required").max(2000),
  // Current route/page, used purely as grounding context in the system prompt.
  page: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).askAi) return bad("askAi feature is disabled", 403);

    const { question, page } = AskBody.parse(await req.json().catch(() => ({})));

    // Attribution: record WHO asked (not the full answer). Best-effort — a failed
    // audit write must never break the response.
    await recordAudit(principal.id, "ai.ask", page ?? "(global)", question.slice(0, 120)).catch(
      () => {},
    );

    // askAi is best-effort end-to-end: it resolves the configured provider, walks
    // the fallback chain, and always resolves with an answer (never throws).
    const { answer, provider, fellBackFrom } = await askAi({ question, context: page });
    return ok({ answer, provider, fellBackFrom });
    // read-only: Ask-AI is purely informational (answers questions about the
    // dashboard, never mutates an instance), so any authenticated operator —
    // including read-only viewers — may use it (operator policy 2026-07-05).
  }, "read-only");
}
