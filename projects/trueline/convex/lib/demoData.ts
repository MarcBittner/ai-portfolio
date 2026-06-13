// Synthetic, clearly-fictional demo data for a freshly-signed-in tenant.
// Vendor invoices billed against a purchase order, checked against catalog
// (market) rates. One clean invoice, one padded, one with errors.

export const DEMO_VENDOR = "Apex Industrial Supply";
export const DEMO_PO_NUMBER = "PO-4471";

export const DEMO_PO_LINES = [
  { sku: "BRK-200", description: '1/2" steel mounting bracket', unit: "ea", quantity: 200, unitPrice: 4.2 },
  { sku: "CBL-12G", description: "12 AWG copper cable", unit: "ft", quantity: 1000, unitPrice: 0.78 },
  { sku: "LED-48", description: '48" LED shop fixture', unit: "ea", quantity: 40, unitPrice: 36.0 },
  { sku: "CONC-60", description: "60 lb concrete mix", unit: "bag", quantity: 120, unitPrice: 6.5 },
  { sku: "LBR-INST", description: "installation labor", unit: "hr", quantity: 80, unitPrice: 65.0 },
];

export const DEMO_CATALOG = [
  { sku: "BRK-200", description: '1/2" steel mounting bracket', unit: "ea", marketPrice: 4.3 },
  { sku: "CBL-12G", description: "12 AWG copper cable", unit: "ft", marketPrice: 0.8 },
  { sku: "LED-48", description: '48" LED shop fixture', unit: "ea", marketPrice: 35.0 },
  { sku: "CONC-60", description: "60 lb concrete mix", unit: "bag", marketPrice: 6.4 },
  { sku: "LBR-INST", description: "installation labor", unit: "hr", marketPrice: 70.0 },
  { sku: "PIPE-2", description: '2" PVC pipe', unit: "ft", marketPrice: 1.15 },
  { sku: "FAST-KIT", description: "fastener assortment kit", unit: "kit", marketPrice: 22.0 },
];

const HEADER = "SKU | Description | Qty | Unit | Unit Price | Extension";

export const DEMO_INVOICES = [
  {
    invoiceNumber: "INV-1009",
    note: "clean — billed at PO rates, math correct",
    rawText: [
      `Apex Industrial Supply — Invoice INV-1009 (PO ${DEMO_PO_NUMBER})`,
      HEADER,
      "BRK-200 | 1/2in steel mounting bracket | 200 | ea | 4.20 | 840.00",
      "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.78 | 780.00",
      "LED-48 | 48in LED shop fixture | 40 | ea | 36.00 | 1440.00",
      "CONC-60 | 60lb concrete mix | 120 | bag | 6.50 | 780.00",
      "LBR-INST | installation labor | 80 | hr | 65.00 | 5200.00",
    ].join("\n"),
  },
  {
    invoiceNumber: "INV-1010",
    note: "padded — three line items priced over PO and market",
    rawText: [
      `Apex Industrial Supply — Invoice INV-1010 (PO ${DEMO_PO_NUMBER})`,
      HEADER,
      "BRK-200 | 1/2in steel mounting bracket | 200 | ea | 4.20 | 840.00",
      "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.95 | 950.00",
      "LED-48 | 48in LED shop fixture | 40 | ea | 44.00 | 1760.00",
      "LBR-INST | installation labor | 80 | hr | 72.00 | 5760.00",
    ].join("\n"),
  },
  {
    invoiceNumber: "INV-1011",
    note: "errors — a math error, an unmatched fee, a small over-charge",
    rawText: [
      `Apex Industrial Supply — Invoice INV-1011 (PO ${DEMO_PO_NUMBER})`,
      HEADER,
      "CONC-60 | 60lb concrete mix | 120 | bag | 6.50 | 850.00",
      "EXP-FEE | expedite handling fee | 1 | ea | 250.00 | 250.00",
      "BRK-200 | 1/2in steel mounting bracket | 150 | ea | 4.35 | 652.50",
    ].join("\n"),
  },
];

// A tiny labeled eval set: the "truth" for whether each invoice should surface
// any red flag. Used by evals.ts to score flag precision/recall.
export const DEMO_EVAL_LABELS: Record<string, boolean> = {
  "INV-1009": false, // no padding — should stay green
  "INV-1010": true, // padded — should flag
  "INV-1011": true, // math error + over-charge — should flag
};
