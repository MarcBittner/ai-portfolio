import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { extractLineItems } from "./lib/llm";

// Internal read used by the action (an action has no ctx.db; it reads through a
// query, which is its own transaction).
export const _getRaw = internalQuery({
  args: { invoiceId: v.id("invoices") },
  handler: async (ctx, { invoiceId }) => {
    const inv = await ctx.db.get(invoiceId);
    return inv ? { rawText: inv.rawText } : null;
  },
});

// The escape hatch for external I/O. Scheduled by createInvoiceFromText. NOT
// transactional and NOT auto-retried, so the work is keyed on the invoice _id
// (writeResults clears + re-inserts) — a re-run can't double-insert.
export const run = internalAction({
  args: { invoiceId: v.id("invoices"), orgId: v.string() },
  handler: async (ctx, { invoiceId, orgId }) => {
    try {
      const inv = await ctx.runQuery(internal.extract._getRaw, { invoiceId });
      if (!inv) return;
      const routing = await ctx.runQuery(internal.routing._forExtract, { orgId });
      const t0 = Date.now();
      const { lines, provider, model } = await extractLineItems(inv.rawText, routing);
      const latencyMs = Date.now() - t0;
      // rough cost estimate (paid only); free + offline are $0
      const inTok = Math.ceil(inv.rawText.length / 4);
      const outTok = Math.ceil(JSON.stringify(lines).length / 4);
      const costUsd =
        provider === "anthropic"
          ? Math.round(((inTok / 1e6) * 1 + (outTok / 1e6) * 5) * 1e6) / 1e6
          : 0;
      // batch all DB writes into a single mutation (one transaction)
      await ctx.runMutation(internal.invoices.writeResults, {
        invoiceId,
        orgId,
        lines,
        provider,
        model,
        latencyMs,
        costUsd,
      });
    } catch (err) {
      await ctx.runMutation(internal.invoices.markError, {
        invoiceId,
        error: String(err).slice(0, 300),
      });
    }
  },
});
