# trueline — real-world sample data (extraction stress test)

Invoices + purchase orders for testing how extraction fares on data that *isn't* the clean
pipe format the demo ships with. Scenarios 01–05 are realistic, varied-format synthetic
samples; **scenario 06 is built from real public data** (a published government bid
tabulation — see its `SOURCE.md`). Each plants known issues so you can score the result.

**Why this exists.** The deterministic fallback ("mock", `parsePipeInvoice` in
`convex/lib/parse.ts`) only understands pipe-delimited text. Real invoices come as CSV,
printed-table PDFs, prose, spreadsheets, markdown, etc. This corpus is the input for the
open development-plan items on **measuring extraction accuracy (mock vs each LLM)** and
**deciding whether the LLM is cost/performance-justified** — see
[`docs/spec/development-plan.md`](../docs/spec/development-plan.md).

> **Note on contracts.** The POs here are kept in pipe format on purpose, because contract
> parsing (`parsePoText`) is deterministic/pipe-only today (LLM contract parsing is a
> roadmap item). So load the pipe PO as the baseline, then upload the varied-format
> *invoice* — that isolates the test to invoice extraction, which is the part routed
> through the LLM.

## How to test

1. On the dashboard, **Reset**, then upload the scenario's `contract-PO-*.txt`.
2. Upload the scenario's `invoice-*`. With a local model reachable it extracts via Ollama;
   with none, it falls to the server (paid → free → offline mock).
3. Compare the extracted lines + flags against the "planted issues" below. To see the
   **mock vs LLM** difference, run the same invoice once with a model and once in offline
   mode (Configuration → mode = offline).

## Scenarios

| # | Folder | Invoice format | What it stresses | Mock (deterministic) expectation |
|---|--------|----------------|------------------|----------------------------------|
| 01 | `01-acme-print-pipe` | pipe `\|` | control — the format the mock handles | ✅ extracts correctly |
| 02 | `02-harbor-marine-csv` | CSV | comma-delimited, header row | ❌ no `\|` → extracts **nothing** |
| 03 | `03-bluepeak-saas-printed` | printed invoice (space-aligned table, **no SKU column**, addresses, subtotal/tax/total) | column inference + fuzzy match by description | ❌ extracts nothing |
| 04 | `04-nordwind-imports-markdown` | markdown table (EUR, discount line) | leading/trailing pipes + a `\|---\|` separator row | ⚠️ **silently mis-parses** — column shift from the leading pipe, plus the separator row as a junk line |
| 05 | `05-delgado-construction-prose` | prose / letterhead (`500x … @ $3.85 … $1,925.00`, **no SKUs**) | hardest — free-form, fuzzy match, freight + tax | ❌ extracts nothing |
| 06 | `06-idea-schools-real-office-supplies` | **real public data** — printed invoice (space-aligned, real SKUs/descriptions/prices from a govt bid tabulation) | real descriptions + SKUs + OCR noise (`QuoƟng`) at scale | ❌ extracts nothing |

Scenario 04 is the important one: the mock doesn't just fail loudly, it produces **wrong
lines that look plausible** — exactly the case where a measured mock-vs-LLM accuracy check
matters.

## Planted issues (the ground truth to score against)

- **01 Acme (pipe):** `INK-CMYK` billed 167.00 vs PO 145.00 → **+15.2% red**; `TAX` line is
  not on the PO → **yellow (unmatched)**. Everything else green.
- **02 Harbor (CSV):** `FEND-8` 25.50 vs 23.00 → **+10.9% red**; `BILGE-P` 15 × 39.00 = 585
  but printed 600.00 → **red (math error)**; `FREIGHT` → **yellow (unmatched)**.
- **03 BluePeak (printed, no SKUs):** `Admin seat` 72.00 vs 60.00 → **+20% red**;
  `Onboarding` → **yellow (unmatched)**. Requires matching by description (no SKU column).
- **04 Nordwind (markdown, EUR):** `GROUT-25` 36.50 vs 32.00 → **+14% red**; `DISC` (negative
  line) → **yellow (unmatched)**. Note: amounts are EUR and the engine does no FX conversion
  (a real-world wrinkle worth surfacing).
- **05 Delgado (prose, no SKUs):** `1/2in drywall` 13.60 vs 12.40 → **+9.7% yellow**;
  `16d framing nails` 20 × 64.00 = 1280 but printed 1290.00 → **red (math error)**;
  `Delivery surcharge` and `Sales tax` → **yellow (unmatched)**. Description-only matching.
- **06 IDEA (real data, printed):** `Logitech M720` 39.50 vs 33.89 → **+16.5% red**;
  `Logitech K120` 50 × 10.65 = 532.50 but printed 560.00 → **red (math error)**;
  `Correction tape` 4.99 vs 4.78 → **+4.4% yellow**; `Restocking fee` → **yellow (unmatched)**.
  Real SKUs/descriptions from the source bid tabulation (see `06-…/SOURCE.md`).

## What to record

For each scenario, with a real model vs offline mock: lines extracted (count + correctness),
field-level accuracy (qty/unitPrice/extension), latency, and (for cloud models) cost. That's
the evidence for whether — and on which formats — LLM extraction earns its place over the
deterministic parser.
