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
      const { lines, provider, model } = await extractLineItems(inv.rawText);
      // batch all DB writes into a single mutation (one transaction)
      await ctx.runMutation(internal.invoices.writeResults, {
        invoiceId,
        orgId,
        lines,
        provider,
        model,
      });
    } catch (err) {
      await ctx.runMutation(internal.invoices.markError, {
        invoiceId,
        error: String(err).slice(0, 300),
      });
    }
  },
});
