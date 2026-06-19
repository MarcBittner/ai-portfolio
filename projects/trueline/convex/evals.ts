import { mutation, query } from "./_generated/server";
import { scoreBenchmark } from "./lib/benchmark";

// Engine regression: score the flag engine on a FIXED, hand-labeled benchmark
// (convex/lib/benchmark.ts) — flag precision/recall and math-consistency. This is
// independent of the tenant's uploaded invoices; it measures the engine itself, the
// gate you'd run in CI before changing a threshold, prompt, or model.

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
    const m = scoreBenchmark(); // pure; no invoice reads

    // The benchmark is deterministic and this is auto-run on every app load, so
    // skip appending an identical run — keep the history meaningful.
    const latest = await ctx.db
      .query("evalRuns")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .first();
    if (
      latest &&
      latest.n === m.n &&
      latest.extractionAccuracy === m.extractionAccuracy &&
      latest.flagPrecision === m.flagPrecision &&
      latest.flagRecall === m.flagRecall
    ) {
      return latest;
    }

    const id = await ctx.db.insert("evalRuns", {
      orgId,
      provider: "engine",
      model: "reconcile-v1",
      n: m.n,
      extractionAccuracy: m.extractionAccuracy,
      flagPrecision: m.flagPrecision,
      flagRecall: m.flagRecall,
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
