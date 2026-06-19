// A fixed, hand-labeled benchmark for the flag engine — independent of any tenant's
// uploaded invoices. `scoreBenchmark()` runs `reconcileLine` over every fixture line
// and reports flag precision/recall (does the engine's RED verdict match the human
// label?) plus math-consistency (share of lines whose printed total checks out).
// This is the regression gate: change a threshold/prompt/model and the numbers move.
import { reconcileLine, type BaselineLine, type CatalogItem } from "./reconcile";
import type { ExtractedLine } from "./parse";

const PO: BaselineLine[] = [
  { sku: "A1", description: "1/2in steel bracket", unit: "ea", quantity: 100, unitPrice: 4.0 },
  { sku: "A2", description: "12 AWG copper cable", unit: "ft", quantity: 100, unitPrice: 12.5 },
  { sku: "A3", description: "48in LED fixture", unit: "ea", quantity: 100, unitPrice: 30.0 },
  { sku: "A4", description: "60lb concrete mix", unit: "bag", quantity: 100, unitPrice: 0.8 },
  { sku: "A5", description: "industrial control panel", unit: "ea", quantity: 100, unitPrice: 150.0 },
  { sku: "A6", description: "installation labor", unit: "hr", quantity: 100, unitPrice: 60.0 },
  { sku: "A7", description: "fastener kit", unit: "ea", quantity: 100, unitPrice: 2.0 },
  { sku: "A8", description: "network switch 48-port", unit: "ea", quantity: 100, unitPrice: 200.0 },
];
// Catalog/market equals the PO rate here, so each line's worst variance is unambiguous.
const CATALOG: CatalogItem[] = PO.map((p) => ({
  sku: p.sku as string,
  description: p.description,
  unit: p.unit,
  marketPrice: p.unitPrice,
}));

const descOf = (sku: string) => PO.find((p) => p.sku === sku)?.description ?? sku;
// line builder: sku, qty, unitPrice, printed extension, optional confidence
const L = (sku: string, q: number, up: number, ext: number, conf = 0.95): ExtractedLine => ({
  description: descOf(sku),
  sku,
  unit: "ea",
  quantity: q,
  unitPrice: up,
  extension: ext,
  confidence: conf,
  sourceQuote: "",
});

export interface BenchmarkInvoice {
  invoiceNumber: string;
  label: boolean; // "should this invoice raise a RED flag?" (real overcharge or math error)
  lines: ExtractedLine[];
}

// 18 invoices spanning the behaviors the flag engine must classify.
export const BENCHMARK_INVOICES: BenchmarkInvoice[] = [
  // clean — at PO rate, math correct → no red
  { invoiceNumber: "BM-01", label: false, lines: [L("A1", 100, 4.0, 400), L("A3", 10, 30.0, 300)] },
  { invoiceNumber: "BM-02", label: false, lines: [L("A5", 5, 150.0, 750), L("A6", 40, 60.0, 2400)] },
  { invoiceNumber: "BM-03", label: false, lines: [L("A2", 20, 12.5, 250), L("A7", 500, 2.0, 1000), L("A4", 1000, 0.8, 800)] },
  // overcharge > 10% → red
  { invoiceNumber: "BM-04", label: true, lines: [L("A1", 100, 4.6, 460)] },
  { invoiceNumber: "BM-05", label: true, lines: [L("A3", 10, 30.0, 300), L("A5", 5, 180.0, 900)] },
  // overcharge 3–10% only → yellow, no red
  { invoiceNumber: "BM-06", label: false, lines: [L("A2", 20, 13.0, 260)] },
  { invoiceNumber: "BM-07", label: false, lines: [L("A6", 40, 63.0, 2520)] },
  // math error → red
  { invoiceNumber: "BM-08", label: true, lines: [L("A1", 100, 4.0, 450)] },
  { invoiceNumber: "BM-09", label: true, lines: [L("A3", 10, 30.0, 300), L("A6", 40, 60.0, 2450)] },
  // unmatched line only (sku absent from PO/catalog) → yellow
  { invoiceNumber: "BM-10", label: false, lines: [L("ZZ-FEE", 1, 99.0, 99)] },
  // undercharge → green
  { invoiceNumber: "BM-11", label: false, lines: [L("A5", 5, 135.0, 675)] },
  // low confidence only → yellow
  { invoiceNumber: "BM-12", label: false, lines: [L("A1", 100, 4.0, 400, 0.5)] },
  // boundary: just over 10% → red
  { invoiceNumber: "BM-13", label: true, lines: [L("A1", 100, 4.401, 440.1)] },
  // boundary: just over 3% → yellow, no red
  { invoiceNumber: "BM-14", label: false, lines: [L("A2", 100, 12.876, 1287.6)] },
  // mixed, contains red
  { invoiceNumber: "BM-15", label: true, lines: [L("A1", 100, 4.0, 400), L("A3", 10, 36.0, 360), L("A7", 500, 2.0, 1000)] },
  { invoiceNumber: "BM-16", label: true, lines: [L("A5", 5, 150.0, 750), L("A6", 40, 75.0, 3000), L("A2", 20, 12.5, 250)] },
  { invoiceNumber: "BM-17", label: true, lines: [L("A1", 100, 4.0, 400), L("A4", 1000, 0.8, 820)] },
  { invoiceNumber: "BM-18", label: true, lines: [L("A3", 10, 33.0, 330), L("A5", 5, 150.0, 800), L("A8", 2, 260.0, 520)] },
];

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export interface BenchmarkScore {
  n: number;
  extractionAccuracy: number; // math-consistency: lines whose totals check out
  flagPrecision: number;
  flagRecall: number;
}

export function scoreBenchmark(): BenchmarkScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let mathConsistent = 0;
  let totalLines = 0;
  for (const inv of BENCHMARK_INVOICES) {
    const reconciled = inv.lines.map((l) => reconcileLine(l, PO, CATALOG));
    totalLines += reconciled.length;
    mathConsistent += reconciled.filter((r) => r.mathOk).length;
    const predicted = reconciled.some((r) => r.flag === "red");
    if (predicted && inv.label) tp++;
    else if (predicted && !inv.label) fp++;
    else if (!predicted && inv.label) fn++;
  }
  return {
    n: BENCHMARK_INVOICES.length,
    extractionAccuracy: totalLines === 0 ? 1 : round3(mathConsistent / totalLines),
    flagPrecision: tp + fp === 0 ? 1 : round3(tp / (tp + fp)),
    flagRecall: tp + fn === 0 ? 1 : round3(tp / (tp + fn)),
  };
}
