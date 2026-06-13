import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { extractLineItems, type RoutingMode } from "./lib/llm";

// Run the same invoice through each routing mode and compare provider, latency,
// and how many line items each recovered. (External I/O → an action.)
export const benchmark = action({
  args: { invoiceText: v.string() },
  handler: async (ctx, { invoiceText }) => {
    const id = (await ctx.auth.getUserIdentity()) as
      | { subject: string; org_id?: string }
      | null;
    const orgId = id ? (id.org_id ?? `user:${id.subject}`) : null;
    const modes: RoutingMode[] = ["offline", "free", "paid"];
    const results: {
      mode: string;
      provider: string;
      model: string;
      latencyMs: number;
      lines: number;
      error: string | null;
    }[] = [];
    for (const mode of modes) {
      const t0 = Date.now();
      let provider = "—";
      let model = "—";
      let lines = 0;
      let error: string | null = null;
      try {
        const r = await extractLineItems(invoiceText, { mode });
        provider = r.provider;
        model = r.model;
        lines = r.lines.length;
      } catch (e) {
        error = String(e).slice(0, 120);
      }
      results.push({ mode, provider, model, latencyMs: Date.now() - t0, lines, error });
    }
    if (orgId) {
      await ctx.runMutation(internal.invoices.appendLog, {
        orgId,
        level: "info",
        event: "benchmark",
        detail: results
          .map((r) => `${r.mode}:${r.provider} ${r.latencyMs}ms/${r.lines}ln`)
          .join(" · "),
      });
    }
    return results;
  },
});
