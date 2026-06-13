import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import {
  DEFAULT_FREE_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_PAID_MODEL,
  keyStatus,
} from "./lib/llm";

const modeValidator = v.union(
  v.literal("auto"),
  v.literal("local"),
  v.literal("free"),
  v.literal("paid"),
  v.literal("offline"),
);

async function tenant(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) {
  const id = (await ctx.auth.getUserIdentity()) as { subject: string; org_id?: string } | null;
  if (!id) return null;
  return id.org_id ?? `user:${id.subject}`;
}

// The full routing configuration + live status, for the Configuration page.
export const get = query({
  args: {},
  handler: async (ctx) => {
    const oid = await tenant(ctx);
    const keys = keyStatus(); // { free, paid } — which provider keys exist
    let mode: "auto" | "local" | "free" | "paid" | "offline" = "auto";
    let model: string | null = null;
    if (oid) {
      const row = await ctx.db
        .query("settings")
        .withIndex("by_org", (q) => q.eq("orgId", oid))
        .first();
      if (row) {
        mode = row.mode;
        model = row.model ?? null;
      }
    }
    const activeMode =
      mode !== "auto"
        ? mode
        : keys.local
          ? "local"
          : keys.paid
            ? "paid"
            : keys.free
              ? "free"
              : "offline";
    return {
      mode,
      model,
      keys,
      defaultLocalModel: DEFAULT_LOCAL_MODEL,
      defaultFreeModel: DEFAULT_FREE_MODEL,
      defaultPaidModel: DEFAULT_PAID_MODEL,
      activeMode,
    };
  },
});

export const set = mutation({
  args: { mode: modeValidator, model: v.optional(v.string()) },
  handler: async (ctx, { mode, model }) => {
    const oid = await tenant(ctx);
    if (!oid) throw new Error("Not authenticated");
    const clean = model && model.trim().length ? model.trim() : undefined;
    const row = await ctx.db
      .query("settings")
      .withIndex("by_org", (q) => q.eq("orgId", oid))
      .first();
    if (row) await ctx.db.patch(row._id, { mode, model: clean });
    else await ctx.db.insert("settings", { orgId: oid, mode, model: clean });
    return { ok: true };
  },
});

// Read by the extract action to route a run.
export const _forExtract = internalQuery({
  args: { orgId: v.string() },
  handler: async (ctx, { orgId }) => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .first();
    return { mode: row?.mode ?? ("auto" as const), model: row?.model };
  },
});
