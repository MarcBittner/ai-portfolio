// Shared types + the deterministic pipe-format parser. Pure (no fetch, no node
// APIs), so it can be imported from mutations (seed) AND actions (extract).

export interface ExtractedLine {
  description: string;
  sku?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  extension: number;
  confidence: number;
  sourceQuote: string;
}

export interface ParsedPoLine {
  sku?: string;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}

// Parse an uploaded purchase-order / contract:
//   SKU | Description | Qty | Unit | Unit Price
export function parsePoText(rawText: string): ParsedPoLine[] {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter((c) => c.length >= 5 && !/^sku$/i.test(c[0]))
    .map((c) => {
      const n = (x: string) => parseFloat((x || "0").replace(/[$,]/g, "")) || 0;
      return {
        sku: c[0] || undefined,
        description: c[1],
        quantity: n(c[2]),
        unit: c[3] || "ea",
        unitPrice: n(c[4]),
      };
    });
}

// Parse our seeded invoice text:
//   SKU | Description | Qty | Unit | Unit Price | Extension
// Used by the seed (so demo data is populated instantly) and as the LLM's
// zero-key fallback in llm.ts.
export function parsePipeInvoice(rawText: string): ExtractedLine[] {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"))
    .map((l) => ({ cells: l.split("|").map((c) => c.trim()), raw: l }))
    .filter(({ cells }) => cells.length >= 6 && !/^sku$/i.test(cells[0]))
    .map(({ cells, raw }) => {
      const n = (x: string) => parseFloat((x || "0").replace(/[$,]/g, "")) || 0;
      return {
        sku: cells[0] || undefined,
        description: cells[1],
        quantity: n(cells[2]),
        unit: cells[3] || "ea",
        unitPrice: n(cells[4]),
        extension: n(cells[5]),
        confidence: 0.9,
        sourceQuote: raw,
      };
    });
}
