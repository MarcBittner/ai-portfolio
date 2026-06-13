// Deterministic verification + reconciliation. The LLM proposes line items;
// THIS code decides everything that touches money:
//   1. recompute the extension (qty * unitPrice) — never trust the model's math
//   2. match each line to the PO line and the catalog rate (sku, else fuzzy desc)
//   3. compute variance vs each baseline
//   4. flag red/yellow/green and estimate recoverable $
// Pure functions, no Convex imports, so they're trivially unit-testable.

import type { ExtractedLine } from "./parse";

export interface BaselineLine {
  sku?: string;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}
export interface CatalogItem {
  sku: string;
  description: string;
  unit: string;
  marketPrice: number;
}

export interface ReconciledFields {
  computedExtension: number;
  mathOk: boolean;
  poUnitPrice?: number;
  catalogPrice?: number;
  matchedBy: "sku" | "description" | "none";
  varianceVsPoPct?: number;
  varianceVsMarketPct?: number;
  flag: "green" | "yellow" | "red";
  reasons: string[];
  recoverableUsd: number;
}

const RED_PCT = 0.1; // >10% over a baseline → overcharge
const YELLOW_PCT = 0.03; // >3% over → watch
const MATH_TOL = 0.01; // 1 cent
const LOW_CONFIDENCE = 0.6;
const FUZZY_MIN = 0.4; // min token-overlap to accept a description match

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function reconcileLine(
  line: ExtractedLine,
  po: BaselineLine[],
  catalog: CatalogItem[],
): ReconciledFields {
  const reasons: string[] = [];

  // 1) verify math in code
  const computedExtension = round2(line.quantity * line.unitPrice);
  const mathOk = Math.abs(computedExtension - line.extension) <= MATH_TOL + 0.005;
  if (!mathOk)
    reasons.push(
      `math: ${line.quantity} × $${line.unitPrice} = $${computedExtension}, invoice says $${line.extension}`,
    );

  // 2) match to PO line, then catalog (sku first, else best fuzzy description)
  let matchedBy: ReconciledFields["matchedBy"] = "none";
  let poLine: BaselineLine | undefined;
  if (line.sku) poLine = po.find((p) => p.sku && p.sku === line.sku);
  if (poLine) matchedBy = "sku";
  else {
    let best = 0;
    for (const p of po) {
      const o = overlap(line.description, p.description);
      if (o > best && o >= FUZZY_MIN) {
        best = o;
        poLine = p;
      }
    }
    if (poLine) matchedBy = "description";
  }

  let cat: CatalogItem | undefined;
  if (line.sku) cat = catalog.find((c) => c.sku === line.sku);
  if (!cat) {
    let best = 0;
    for (const c of catalog) {
      const o = overlap(line.description, c.description);
      if (o > best && o >= FUZZY_MIN) {
        best = o;
        cat = c;
      }
    }
  }

  const poUnitPrice = poLine?.unitPrice;
  const catalogPrice = cat?.marketPrice;

  // 3) variance vs each baseline
  const variance = (base?: number) =>
    base && base > 0 ? round2(((line.unitPrice - base) / base) * 100) : undefined;
  const varianceVsPoPct = variance(poUnitPrice);
  const varianceVsMarketPct = variance(catalogPrice);

  // 4) flag + recoverable $
  let flag: ReconciledFields["flag"] = "green";
  const escalate = (to: "yellow" | "red") => {
    if (to === "red") flag = "red";
    else if (flag === "green") flag = "yellow";
  };

  if (!mathOk) escalate("red");
  if (matchedBy === "none") {
    escalate("yellow");
    reasons.push("no PO or catalog match — cannot verify the rate");
  }
  if (line.confidence < LOW_CONFIDENCE) {
    escalate("yellow");
    reasons.push(`low extraction confidence (${line.confidence.toFixed(2)})`);
  }
  const worst = Math.max(varianceVsPoPct ?? -Infinity, varianceVsMarketPct ?? -Infinity);
  if (worst !== -Infinity) {
    if (worst > RED_PCT * 100) {
      escalate("red");
      reasons.push(`unit price ${worst.toFixed(1)}% over baseline`);
    } else if (worst > YELLOW_PCT * 100) {
      escalate("yellow");
      reasons.push(`unit price ${worst.toFixed(1)}% over baseline`);
    }
  }

  // recoverable = overcharge vs the *lower* available baseline, only when over
  const benchmark = Math.min(poUnitPrice ?? Infinity, catalogPrice ?? Infinity);
  const recoverableUsd =
    benchmark !== Infinity && line.unitPrice > benchmark
      ? round2((line.unitPrice - benchmark) * line.quantity)
      : 0;

  if (flag === "green") reasons.push("within tolerance of PO and market");

  return {
    computedExtension,
    mathOk,
    poUnitPrice,
    catalogPrice,
    matchedBy,
    varianceVsPoPct,
    varianceVsMarketPct,
    flag,
    reasons,
    recoverableUsd,
  };
}
