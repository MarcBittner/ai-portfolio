import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Every document is scoped by `orgId` (the active Clerk organization), which is
// how multi-tenancy works on this stack: the orgId rides in the Clerk JWT, is
// read in each Convex function via `ctx.auth.getUserIdentity()`, and filtered
// through an index so one tenant can never read another's rows.

const flag = v.union(v.literal("green"), v.literal("yellow"), v.literal("red"));
const decision = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("edited"),
  v.literal("rejected"),
);

export default defineSchema({
  // Baseline #1: the purchase order the invoice is billed against.
  purchaseOrders: defineTable({
    orgId: v.string(),
    poNumber: v.string(),
    vendor: v.string(),
    lines: v.array(
      v.object({
        sku: v.optional(v.string()),
        description: v.string(),
        unit: v.string(),
        quantity: v.number(),
        unitPrice: v.number(),
      }),
    ),
  })
    .index("by_org", ["orgId"])
    .index("by_org_po", ["orgId", "poNumber"]),

  // Baseline #2: catalog / market rates (the "should cost" reference).
  catalog: defineTable({
    orgId: v.string(),
    sku: v.string(),
    description: v.string(),
    unit: v.string(),
    marketPrice: v.number(),
    category: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_sku", ["orgId", "sku"]),

  invoices: defineTable({
    orgId: v.string(),
    invoiceNumber: v.string(),
    vendor: v.string(),
    poNumber: v.optional(v.string()),
    rawText: v.string(),
    status: v.union(
      v.literal("extracting"),
      v.literal("needs_review"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    // populated by the extract action after the LLM + reconcile pass
    claimedTotal: v.optional(v.number()),
    recoverableUsd: v.optional(v.number()),
    extractionProvider: v.optional(v.string()),
    extractionModel: v.optional(v.string()),
    error: v.optional(v.string()),
    uploadedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  invoiceLines: defineTable({
    orgId: v.string(),
    invoiceId: v.id("invoices"),
    lineNo: v.number(),
    // ---- what the LLM read (it only reads; it never decides) ----
    description: v.string(),
    sku: v.optional(v.string()),
    unit: v.string(),
    quantity: v.number(),
    unitPrice: v.number(),
    claimedExtension: v.number(), // the number printed on the invoice
    confidence: v.number(), // 0..1, per-line, from the model
    sourceQuote: v.string(), // grounds the numbers; reviewer can trace back
    // ---- what deterministic code verified/decided ----
    computedExtension: v.number(), // qty * unitPrice, recomputed in code
    mathOk: v.boolean(),
    poUnitPrice: v.optional(v.number()),
    catalogPrice: v.optional(v.number()),
    matchedBy: v.optional(v.string()), // "sku" | "description" | "none"
    varianceVsPoPct: v.optional(v.number()),
    varianceVsMarketPct: v.optional(v.number()),
    flag,
    reasons: v.array(v.string()),
    recoverableUsd: v.number(),
    // ---- human-in-the-loop ----
    decision,
    reviewer: v.optional(v.string()),
  })
    .index("by_invoice", ["invoiceId"])
    .index("by_org_decision", ["orgId", "decision"]),

  // Eval runs: extraction accuracy + flag precision/recall over a labeled set.
  evalRuns: defineTable({
    orgId: v.string(),
    provider: v.string(),
    model: v.string(),
    n: v.number(),
    extractionAccuracy: v.number(), // fields read correctly / total
    flagPrecision: v.number(),
    flagRecall: v.number(),
    createdBy: v.optional(v.string()),
  }).index("by_org", ["orgId"]),
});
