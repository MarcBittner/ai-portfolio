import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { reconcileLine } from "./lib/reconcile";
import { parsePipeInvoice, parsePoText, type ExtractedLine } from "./lib/parse";
import {
  DEMO_CATALOG,
  DEMO_INVOICES,
  DEMO_PO_LINES,
  DEMO_PO_NUMBER,
  DEMO_VENDOR,
} from "./lib/demoData";

// ---- multi-tenancy: derive the tenant from the Clerk identity ----
// Prefer the active organization (org_id claim); fall back to a per-user tenant
// so a reviewer who hasn't created an org still gets an isolated, seeded space.
async function requireOrg(ctx: { auth: MutationCtx["auth"] }) {
  const id = await ctx.auth.getUserIdentity();
  if (!id) throw new Error("Not authenticated");
  const claims = id as unknown as { org_id?: string };
  const orgId = claims.org_id ?? `user:${id.subject}`;
  const who = id.email ?? id.name ?? id.subject;
  return { orgId, who };
}

// Like requireOrg but never throws — returns null when the request isn't
// authenticated yet (Convex auth can lag a render behind Clerk). Read queries
// use this so a transient unauthenticated render shows an empty state instead
// of throwing (which would crash the client with a white screen).
async function optionalOrg(ctx: { auth: MutationCtx["auth"] }): Promise<string | null> {
  const id = await ctx.auth.getUserIdentity();
  if (!id) return null;
  const claims = id as unknown as { org_id?: string };
  return claims.org_id ?? `user:${id.subject}`;
}

// Reconcile a set of extracted lines against the org's PO + catalog and write
// them, returning the invoice rollups. Shared by the seed and the extract action.
async function insertReconciledLines(
  ctx: MutationCtx,
  args: { orgId: string; invoiceId: Id<"invoices">; extracted: ExtractedLine[] },
) {
  const { orgId, invoiceId, extracted } = args;
  const pos = await ctx.db
    .query("purchaseOrders")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const poLines = pos.flatMap((p) => p.lines);
  const catalog = await ctx.db
    .query("catalog")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  // idempotent: clear any prior lines for this invoice before re-inserting
  const existing = await ctx.db
    .query("invoiceLines")
    .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
    .collect();
  for (const l of existing) await ctx.db.delete(l._id);

  let recoverableUsd = 0;
  let claimedTotal = 0;
  let lineNo = 0;
  for (const line of extracted) {
    const r = reconcileLine(line, poLines, catalog);
    recoverableUsd += r.recoverableUsd;
    claimedTotal += line.extension;
    await ctx.db.insert("invoiceLines", {
      orgId,
      invoiceId,
      lineNo: ++lineNo,
      description: line.description,
      sku: line.sku,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      claimedExtension: line.extension,
      confidence: line.confidence,
      sourceQuote: line.sourceQuote,
      ...r,
      decision: "pending",
    });
  }
  return {
    recoverableUsd: Math.round(recoverableUsd * 100) / 100,
    claimedTotal: Math.round(claimedTotal * 100) / 100,
  };
}

// ---- queries (reactive reads) ----

export const listInvoices = query({
  args: {},
  handler: async (ctx) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId) return [];
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .collect();
    return Promise.all(
      invoices.map(async (inv) => {
        const lines = await ctx.db
          .query("invoiceLines")
          .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
          .collect();
        const count = (f: string) => lines.filter((l) => l.flag === f).length;
        return {
          ...inv,
          lineCount: lines.length,
          red: count("red"),
          yellow: count("yellow"),
          green: count("green"),
        };
      }),
    );
  },
});

export const getInvoice = query({
  args: { invoiceId: v.id("invoices") },
  handler: async (ctx, { invoiceId }) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId) return null;
    const invoice = await ctx.db.get(invoiceId);
    if (!invoice || invoice.orgId !== orgId) return null;
    const lines = await ctx.db
      .query("invoiceLines")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
      .collect();
    lines.sort((a, b) => a.lineNo - b.lineNo);
    return { invoice, lines };
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId)
      return { invoices: 0, recoverableUsd: 0, needsReview: 0, latestEval: null };
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const evals = await ctx.db
      .query("evalRuns")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .take(1);
    return {
      invoices: invoices.length,
      recoverableUsd: Math.round(
        invoices.reduce((s, i) => s + (i.recoverableUsd ?? 0), 0) * 100,
      ) / 100,
      needsReview: invoices.filter((i) => i.status === "needs_review").length,
      latestEval: evals[0] ?? null,
    };
  },
});

// ---- mutations (transactional writes) ----

export const seedIfEmpty = mutation({
  args: {},
  handler: async (ctx) => {
    const { orgId } = await requireOrg(ctx);
    const existing = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .first();
    if (existing) return { seeded: false };

    await ctx.db.insert("purchaseOrders", {
      orgId,
      poNumber: DEMO_PO_NUMBER,
      vendor: DEMO_VENDOR,
      lines: DEMO_PO_LINES,
    });
    for (const c of DEMO_CATALOG) await ctx.db.insert("catalog", { orgId, ...c });

    for (const inv of DEMO_INVOICES) {
      const invoiceId = await ctx.db.insert("invoices", {
        orgId,
        invoiceNumber: inv.invoiceNumber,
        vendor: DEMO_VENDOR,
        poNumber: DEMO_PO_NUMBER,
        rawText: inv.rawText,
        status: "needs_review",
        extractionProvider: "seed",
        extractionModel: "deterministic",
      });
      const rollup = await insertReconciledLines(ctx, {
        orgId,
        invoiceId,
        extracted: parsePipeInvoice(inv.rawText),
      });
      await ctx.db.patch(invoiceId, rollup);
    }
    return { seeded: true };
  },
});

export const createInvoiceFromText = mutation({
  // deferServer: the client will try host-local Ollama in the browser first and
  // submit the result via submitExtraction; only schedule the server action if
  // that doesn't happen (see scheduleExtract).
  args: {
    invoiceNumber: v.string(),
    rawText: v.string(),
    poNumber: v.optional(v.string()),
    deferServer: v.optional(v.boolean()),
  },
  handler: async (ctx, { invoiceNumber, rawText, poNumber, deferServer }) => {
    const { orgId, who } = await requireOrg(ctx);
    const invoiceId = await ctx.db.insert("invoices", {
      orgId,
      invoiceNumber,
      vendor: DEMO_VENDOR,
      poNumber: poNumber ?? DEMO_PO_NUMBER,
      rawText,
      status: "extracting",
      uploadedBy: who,
    });
    await ctx.db.insert("logs", {
      orgId,
      level: "info",
      event: "upload",
      detail: `${invoiceNumber} uploaded${deferServer ? " — trying local Ollama in browser" : " — extraction scheduled"}`,
    });
    if (!deferServer) {
      await ctx.scheduler.runAfter(0, internal.extract.run, { invoiceId, orgId });
    }
    return invoiceId;
  },
});

// Fallback: the client calls this if host-local Ollama wasn't reachable, so the
// server action (paid → free → offline) takes over.
export const scheduleExtract = mutation({
  args: { invoiceId: v.id("invoices") },
  handler: async (ctx, { invoiceId }) => {
    const { orgId } = await requireOrg(ctx);
    const inv = await ctx.db.get(invoiceId);
    if (!inv || inv.orgId !== orgId) throw new Error("not found");
    await ctx.scheduler.runAfter(0, internal.extract.run, { invoiceId, orgId });
  },
});

// Accept line items extracted in the browser (by the host's local Ollama),
// reconcile + write them. Lets a cloud-hosted backend use a model running on the
// user's machine — the browser reaches localhost, the cloud action cannot.
export const submitExtraction = mutation({
  args: {
    invoiceId: v.id("invoices"),
    provider: v.string(),
    model: v.string(),
    latencyMs: v.optional(v.number()),
    lines: v.array(
      v.object({
        description: v.string(),
        sku: v.optional(v.string()),
        quantity: v.number(),
        unit: v.string(),
        unitPrice: v.number(),
        extension: v.number(),
        confidence: v.number(),
        sourceQuote: v.string(),
      }),
    ),
  },
  handler: async (ctx, { invoiceId, provider, model, latencyMs, lines }) => {
    const { orgId } = await requireOrg(ctx);
    const inv = await ctx.db.get(invoiceId);
    if (!inv || inv.orgId !== orgId) throw new Error("not found");
    const rollup = await insertReconciledLines(ctx, { orgId, invoiceId, extracted: lines });
    await ctx.db.patch(invoiceId, {
      status: "needs_review",
      extractionProvider: provider,
      extractionModel: model,
      latencyMs,
      costUsd: 0,
      error: undefined,
      ...rollup,
    });
    await ctx.db.insert("logs", {
      orgId,
      level: "info",
      event: "extract",
      detail: `${inv.invoiceNumber}: ${provider}/${model} · ${lines.length} lines (browser→host)`,
      latencyMs,
    });
  },
});

// Whether a baseline contract (PO) has been uploaded yet — drives the guided UI.
export const baseline = query({
  args: {},
  handler: async (ctx) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId) return { hasPo: false, poLines: 0, poNumber: null, vendor: null };
    const po = await ctx.db
      .query("purchaseOrders")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .first();
    return po
      ? { hasPo: true, poLines: po.lines.length, poNumber: po.poNumber, vendor: po.vendor }
      : { hasPo: false, poLines: 0, poNumber: null, vendor: null };
  },
});

// Upload a contract / purchase order: parse it, make it the baseline, and seed
// the market-rate reference catalog if one isn't present.
export const setBaselineFromText = mutation({
  args: { rawText: v.string(), poNumber: v.optional(v.string()) },
  handler: async (ctx, { rawText, poNumber }) => {
    const { orgId } = await requireOrg(ctx);
    const lines = parsePoText(rawText);
    if (lines.length === 0) throw new Error("No line items found in the contract file.");
    const existing = await ctx.db
      .query("purchaseOrders")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    await ctx.db.insert("purchaseOrders", {
      orgId,
      poNumber: poNumber ?? DEMO_PO_NUMBER,
      vendor: DEMO_VENDOR,
      lines,
    });
    const cat = await ctx.db
      .query("catalog")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .first();
    if (!cat) for (const c of DEMO_CATALOG) await ctx.db.insert("catalog", { orgId, ...c });
    await ctx.db.insert("logs", {
      orgId,
      level: "info",
      event: "baseline",
      detail: `contract loaded — ${lines.length} agreed line items`,
    });
    return { poLines: lines.length };
  },
});

// Clear the tenant so the guided demo can start from empty.
export const resetDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const { orgId } = await requireOrg(ctx);
    const invs = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    for (const inv of invs) {
      const ls = await ctx.db
        .query("invoiceLines")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
        .collect();
      for (const l of ls) await ctx.db.delete(l._id);
      await ctx.db.delete(inv._id);
    }
    for (const t of ["purchaseOrders", "catalog", "evalRuns"] as const) {
      const rows = await ctx.db
        .query(t)
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    return { cleared: true };
  },
});

export const reviewLine = mutation({
  args: {
    lineId: v.id("invoiceLines"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  handler: async (ctx, { lineId, decision }) => {
    const { orgId, who } = await requireOrg(ctx);
    const line = await ctx.db.get(lineId);
    if (!line || line.orgId !== orgId) throw new Error("not found");
    await ctx.db.patch(lineId, { decision, reviewer: who });
  },
});

export const correctLine = mutation({
  // an estimator's edit re-runs the deterministic reconcile and is a label
  args: { lineId: v.id("invoiceLines"), unitPrice: v.number(), quantity: v.optional(v.number()) },
  handler: async (ctx, { lineId, unitPrice, quantity }) => {
    const { orgId, who } = await requireOrg(ctx);
    const line = await ctx.db.get(lineId);
    if (!line || line.orgId !== orgId) throw new Error("not found");
    const pos = await ctx.db
      .query("purchaseOrders")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const catalog = await ctx.db
      .query("catalog")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const qty = quantity ?? line.quantity;
    const r = reconcileLine(
      {
        description: line.description,
        sku: line.sku,
        quantity: qty,
        unit: line.unit,
        unitPrice,
        extension: Math.round(qty * unitPrice * 100) / 100,
        confidence: line.confidence,
        sourceQuote: line.sourceQuote,
      },
      pos.flatMap((p) => p.lines),
      catalog,
    );
    await ctx.db.patch(lineId, {
      unitPrice,
      quantity: qty,
      claimedExtension: Math.round(qty * unitPrice * 100) / 100,
      ...r,
      decision: "edited",
      reviewer: who,
    });
  },
});

export const setInvoiceStatus = mutation({
  args: {
    invoiceId: v.id("invoices"),
    status: v.union(v.literal("approved"), v.literal("rejected"), v.literal("needs_review")),
  },
  handler: async (ctx, { invoiceId, status }) => {
    const { orgId } = await requireOrg(ctx);
    const inv = await ctx.db.get(invoiceId);
    if (!inv || inv.orgId !== orgId) throw new Error("not found");
    await ctx.db.patch(invoiceId, { status });
  },
});

// ---- internal mutation: the extract action writes results back here ----
// One transaction for all the DB work (the action's external step is separate).
export const writeResults = internalMutation({
  args: {
    invoiceId: v.id("invoices"),
    orgId: v.string(),
    lines: v.array(
      v.object({
        description: v.string(),
        sku: v.optional(v.string()),
        quantity: v.number(),
        unit: v.string(),
        unitPrice: v.number(),
        extension: v.number(),
        confidence: v.number(),
        sourceQuote: v.string(),
      }),
    ),
    provider: v.string(),
    model: v.string(),
    latencyMs: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, { invoiceId, orgId, lines, provider, model, latencyMs, costUsd }) => {
    const rollup = await insertReconciledLines(ctx, { orgId, invoiceId, extracted: lines });
    await ctx.db.patch(invoiceId, {
      status: "needs_review",
      extractionProvider: provider,
      extractionModel: model,
      latencyMs,
      costUsd,
      error: undefined,
      ...rollup,
    });
  },
});

export const markError = internalMutation({
  args: { invoiceId: v.id("invoices"), error: v.string() },
  handler: async (ctx, { invoiceId, error }) => {
    await ctx.db.patch(invoiceId, { status: "needs_review", error });
  },
});

// ---- event log (Diagnostics tab) ----
const levelV = v.union(v.literal("info"), v.literal("warn"), v.literal("error"));

export const appendLog = internalMutation({
  args: {
    orgId: v.string(),
    level: levelV,
    event: v.string(),
    detail: v.string(),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("logs", a);
  },
});

export const recentLogs = query({
  args: {},
  handler: async (ctx) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId) return [];
    return ctx.db
      .query("logs")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .take(60);
  },
});
