// First unit coverage for the deterministic reconciliation engine.
// Run with `npm test` (vitest). These exercise the money-critical paths:
// math verification, baseline matching (incl. the cross-SKU borrowing bug),
// the variance flag thresholds (incl. the rounding-boundary bug), confidence,
// and recoverable-$ selection. Plus a couple of parser cases.

import { describe, it, expect } from "vitest";
import { reconcileLine, type BaselineLine, type CatalogItem } from "../convex/lib/reconcile";
import { parsePipeInvoice, parsePoText, type ExtractedLine } from "../convex/lib/parse";

// Convenience: build a fully-specified invoice line with sensible defaults.
function line(p: Partial<ExtractedLine> = {}): ExtractedLine {
  const quantity = p.quantity ?? 10;
  const unitPrice = p.unitPrice ?? 100;
  return {
    description: p.description ?? "Widget A",
    sku: p.sku,
    quantity,
    unit: p.unit ?? "ea",
    unitPrice,
    extension: p.extension ?? quantity * unitPrice,
    confidence: p.confidence ?? 0.9,
    sourceQuote: p.sourceQuote ?? "row",
  };
}

const po = (o: Partial<BaselineLine> = {}): BaselineLine => ({
  sku: o.sku,
  description: o.description ?? "Widget A",
  unit: o.unit ?? "ea",
  quantity: o.quantity ?? 10,
  unitPrice: o.unitPrice ?? 100,
});

const cat = (o: Partial<CatalogItem> = {}): CatalogItem => ({
  sku: o.sku ?? "SKU-A",
  description: o.description ?? "Widget A",
  unit: o.unit ?? "ea",
  marketPrice: o.marketPrice ?? 100,
});

describe("reconcileLine — clean line", () => {
  it("at PO rate → green, mathOk, recoverable 0", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 100, quantity: 10, extension: 1000 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.mathOk).toBe(true);
    expect(r.matchedBy).toBe("sku");
    expect(r.flag).toBe("green");
    expect(r.recoverableUsd).toBe(0);
    expect(r.varianceVsPoPct).toBe(0);
  });
});

describe("reconcileLine — variance flag thresholds (BUG 2 rounding boundary)", () => {
  it("3.0001% over the PO baseline must flag yellow (not escape via rounding)", () => {
    // 100 → 103.0001 is 3.0001% over. Rounds to 3.00 for display, but the
    // comparison must use the unrounded value so 3.0001 > 3 is true.
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 103.0001, quantity: 1, extension: 103.0001 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.varianceVsPoPct).toBe(3); // stored value still rounded
    expect(r.flag).toBe("yellow");
  });

  it("exactly 3.00% over → still green (boundary is strictly greater)", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 103, quantity: 1, extension: 103 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.flag).toBe("green");
  });

  it("10.1% over → red", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 110.1, quantity: 1, extension: 110.1 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.flag).toBe("red");
  });

  it("10.0001% over must flag red (rounding-boundary, BUG 2)", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 110.0001, quantity: 1, extension: 110.0001 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.flag).toBe("red");
  });
});

describe("reconcileLine — math tolerance", () => {
  it("passes within 1 cent", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 100, quantity: 10, extension: 1000.01 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.mathOk).toBe(true);
  });

  it("fails (and goes red) when the extension is off by dollars", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 100, quantity: 10, extension: 1100 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.mathOk).toBe(false);
    expect(r.flag).toBe("red");
  });
});

describe("reconcileLine — SKU-less fuzzy description match", () => {
  it("a line with no SKU still matches by description", () => {
    const r = reconcileLine(
      line({ sku: undefined, description: "Premium Steel Widget Assembly", unitPrice: 100 }),
      [po({ sku: "SKU-A", description: "Steel Widget Assembly", unitPrice: 100 })],
      [cat({ sku: "SKU-A", description: "Steel Widget Assembly", marketPrice: 100 })],
    );
    expect(r.matchedBy).toBe("description");
    expect(r.poUnitPrice).toBe(100);
    expect(r.catalogPrice).toBe(100);
  });
});

describe("reconcileLine — BUG 1 cross-SKU price borrowing", () => {
  it("SKU set but absent from PO/catalog must NOT borrow a different SKU's price", () => {
    // The line's SKU (SKU-Z) is not in the PO or catalog, but its description
    // token-overlaps SKU-A's. Before the fix it borrowed SKU-A's $100 baseline
    // and fabricated a red overcharge + recoverable $. After the fix: no match.
    const r = reconcileLine(
      line({
        sku: "SKU-Z",
        description: "Steel Widget Assembly Deluxe",
        unitPrice: 500,
        quantity: 10,
        extension: 5000,
      }),
      [po({ sku: "SKU-A", description: "Steel Widget Assembly", unitPrice: 100 })],
      [cat({ sku: "SKU-A", description: "Steel Widget Assembly", marketPrice: 100 })],
    );
    expect(r.matchedBy).toBe("none");
    expect(r.poUnitPrice).toBeUndefined();
    expect(r.catalogPrice).toBeUndefined();
    expect(r.recoverableUsd).toBe(0);
    expect(r.flag).not.toBe("red"); // no guessed baseline → no overcharge red
    expect(r.varianceVsPoPct).toBeUndefined();
    expect(r.varianceVsMarketPct).toBeUndefined();
  });

  it("exact SKU match still works (regression guard for the fix)", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 150, quantity: 10, extension: 1500 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.matchedBy).toBe("sku");
    expect(r.poUnitPrice).toBe(100);
  });
});

describe("reconcileLine — confidence", () => {
  it("low extraction confidence (<0.6) → yellow", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 100, quantity: 10, extension: 1000, confidence: 0.4 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.flag).toBe("yellow");
    expect(r.reasons.some((x) => /confidence/.test(x))).toBe(true);
  });
});

describe("reconcileLine — recoverable $", () => {
  it("undercharge → recoverable 0", () => {
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 80, quantity: 10, extension: 800 }),
      [po({ sku: "SKU-A", unitPrice: 100 })],
      [cat({ sku: "SKU-A", marketPrice: 100 })],
    );
    expect(r.recoverableUsd).toBe(0);
  });

  it("uses the LOWER of disagreeing PO/catalog baselines", () => {
    // PO says $120, catalog says $90; invoice billed $150 for 10 → recoverable
    // is measured against the lower ($90): (150 - 90) * 10 = 600.
    const r = reconcileLine(
      line({ sku: "SKU-A", unitPrice: 150, quantity: 10, extension: 1500 }),
      [po({ sku: "SKU-A", unitPrice: 120 })],
      [cat({ sku: "SKU-A", marketPrice: 90 })],
    );
    expect(r.recoverableUsd).toBe(600);
    expect(r.flag).toBe("red");
  });
});

describe("parsePipeInvoice", () => {
  it("drops the header and short rows, sanitizes $ and commas", () => {
    const raw = [
      "SKU | Description | Qty | Unit | Unit Price | Extension",
      "SKU-A | Widget A | 10 | ea | $1,250.50 | $12,505.00",
      "SKU-B | too short row | 5",
    ].join("\n");
    const rows = parsePipeInvoice(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("SKU-A");
    expect(rows[0].unitPrice).toBe(1250.5);
    expect(rows[0].extension).toBe(12505);
    expect(rows[0].quantity).toBe(10);
  });
});

describe("reviewer correction of an unlisted line", () => {
  // An unmatched line (no PO/catalog) is yellow: "cannot verify the rate".
  const unlisted = line({ description: "expedite handling fee", quantity: 1, unitPrice: 250, extension: 250 });

  it("stays yellow and unverifiable with no baseline and no override", () => {
    const r = reconcileLine(unlisted, [po({ sku: "A1", description: "steel bracket" })], []);
    expect(r.matchedBy).toBe("none");
    expect(r.flag).toBe("yellow");
  });

  it("becomes a green manual match once the reviewer accepts a rate", () => {
    // correctLine passes acceptedUnitPrice = the entered unit price.
    const r = reconcileLine(
      unlisted,
      [po({ sku: "A1", description: "steel bracket" })],
      [],
      { acceptedUnitPrice: 250 },
    );
    expect(r.matchedBy).toBe("manual");
    expect(r.flag).toBe("green");
    expect(r.recoverableUsd).toBe(0);
    expect(r.reasons.some((x) => x.includes("accepted by reviewer"))).toBe(true);
  });

  it("does NOT override a line that genuinely matches the PO (still flags overcharge)", () => {
    const matched = line({ sku: "A1", description: "steel bracket", quantity: 10, unitPrice: 120, extension: 1200 });
    const r = reconcileLine(matched, [po({ sku: "A1", description: "steel bracket", unitPrice: 100 })], [], {
      acceptedUnitPrice: 120,
    });
    expect(r.matchedBy).toBe("sku");
    expect(r.flag).toBe("red"); // +20% over PO — the override is ignored for matched lines
  });
});

describe("parsePoText", () => {
  it("drops the header and short rows, sanitizes $ and commas", () => {
    const raw = [
      "SKU | Description | Qty | Unit | Unit Price",
      "SKU-A | Widget A | 10 | ea | $1,250.50",
      "broken | row",
    ].join("\n");
    const rows = parsePoText(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("SKU-A");
    expect(rows[0].unitPrice).toBe(1250.5);
  });
});
