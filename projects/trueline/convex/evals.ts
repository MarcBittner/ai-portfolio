import { mutation, query } from "./_generated/server";
import { DEMO_EVAL_LABELS } from "./lib/demoData";

// Score the reconcile engine on the labeled demo set: for each invoice we know
// whether it *should* surface a red flag (truth), and check what the engine did
// (predicted = any red line). This is the gate you'd run in CI before shipping a
// threshold / prompt / model change. Extraction "math-consistency" is the share
// of lines whose printed extension matches qty×price (caught in code).

async function requireOrg(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) {
  const id = (await ctx.auth.getUserIdentity()) as
    | { subject: string; org_id?: string; email?: string; name?: string }
    | null;
  if (!id) throw new Error("Not authenticated");
  return {
    orgId: id.org_id ?? `user:${id.subject}`,
    who: id.email ?? id.name ?? id.subject,
  };
}

export const runEval = mutation({
  args: {},
  handler: async (ctx) => {
    const { orgId, who } = await requireOrg(ctx);
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let n = 0;
    let mathConsistent = 0;
    let totalLines = 0;

    for (const inv of invoices) {
      const truth = DEMO_EVAL_LABELS[inv.invoiceNumber];
      const lines = await ctx.db
        .query("invoiceLines")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
        .collect();
      totalLines += lines.length;
      mathConsistent += lines.filter((l) => l.mathOk).length;
      if (truth === undefined) continue; // only labeled invoices count
      n++;
      const predicted = lines.some((l) => l.flag === "red");
      if (predicted && truth) tp++;
      else if (predicted && !truth) fp++;
      else if (!predicted && truth) fn++;
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const extractionAccuracy = totalLines === 0 ? 1 : mathConsistent / totalLines;

    const id = await ctx.db.insert("evalRuns", {
      orgId,
      provider: "engine",
      model: "reconcile-v1",
      n,
      extractionAccuracy: Math.round(extractionAccuracy * 1000) / 1000,
      flagPrecision: Math.round(precision * 1000) / 1000,
      flagRecall: Math.round(recall * 1000) / 1000,
      createdBy: who,
    });
    return await ctx.db.get(id);
  },
});

export const listEvals = query({
  args: {},
  handler: async (ctx) => {
    const id = (await ctx.auth.getUserIdentity()) as
      | { subject: string; org_id?: string }
      | null;
    if (!id) return [];
    const orgId = id.org_id ?? `user:${id.subject}`;
    return ctx.db
      .query("evalRuns")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .take(10);
  },
});
