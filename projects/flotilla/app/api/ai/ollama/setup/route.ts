import { z } from "zod";
import { withOperator, ok } from "@/lib/api";
import { getConfigValues, recordAudit } from "@/lib/models";
import {
  isOllamaSetupStep,
  ollamaBinaryAvailable,
  ollamaSetupCommands,
  resolveOllamaModel,
  runOllamaSetupStep,
  type OllamaSetupStep,
} from "@/lib/ollamaSetup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/ai/ollama/setup — run the ONE thing a browser can't: the local-Ollama
// setup, but ONLY on a server host that actually has the `ollama` binary (local
// dev / a self-hosted box / the worker). On Vercel/serverless the binary is absent
// and this honestly reports "not available here — run it locally"; it NEVER crashes.
//
// SECURITY / SHAPE:
//   • POST is admin-gated (same floor as retargeting ollamaUrl in /api/config —
//     spawning a process on the server host is at least that sensitive).
//   • The runnable steps are a CLOSED allowlist ("serve" | "pull"); the request
//     names a step by key and nothing else. There is NO arbitrary command path and
//     NO user-supplied argv — the model comes from server config and is charset-
//     validated before it can reach `ollama pull` (see lib/ollamaSetup.ts).
//   • `install` is intentionally NOT runnable here (piping a remote script to a
//     shell as the server user on a click is exactly what we won't do) — it's
//     returned as a copy-only command for the operator to run themselves.
//   • No secrets are involved or logged (Ollama setup takes no credentials).

// GET — what the AI Providers card needs to render the setup affordance: is the
// `ollama` binary present on THIS server (can we offer a "run it here" button?),
// the resolved model the router will use, and the exact copy-able commands (the
// always-available fallback for the prod/serverless case).
export async function GET() {
  return withOperator(async () => {
    const values = await getConfigValues().catch(() => null);
    const model = resolveOllamaModel(values?.aiModel);
    // Never throws — a missing binary resolves false.
    const serverCanRun = await ollamaBinaryAvailable();
    return ok({
      serverCanRun,
      model,
      commands: ollamaSetupCommands(model),
    });
  }, "read-only");
}

const SetupBody = z.object({
  step: z
    .string()
    .refine(isOllamaSetupStep, "step must be one of: serve, pull"),
});

// POST { step: "serve" | "pull" } — run one allowlisted setup step on the server
// host. Admin-gated. Returns { ok, code, message, output? } where code is:
//   "ran"            — the step ran on this host,
//   "not_available"  — no `ollama` binary here; run the commands locally instead,
//   "failed"         — the binary ran but the step failed (output has the tail).
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const { step } = SetupBody.parse(await req.json().catch(() => ({})));
    const stepTyped = step as OllamaSetupStep;

    const values = await getConfigValues().catch(() => null);
    const model = resolveOllamaModel(values?.aiModel);

    // Attribution: record WHO ran WHAT (best-effort; a failed audit must not change
    // the outcome). No secrets — the step + model are safe to record.
    await recordAudit(
      principal.id,
      "ai.ollama.setup",
      stepTyped,
      stepTyped === "pull" ? model : "",
    ).catch(() => {});

    const result = await runOllamaSetupStep(stepTyped, model);
    return ok({ ...result });
  }, "admin");
}
