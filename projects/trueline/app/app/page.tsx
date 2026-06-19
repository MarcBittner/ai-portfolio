"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";
import { Button, buttonCls, FlagBadge, StatusBadge, usd } from "@/app/components/ui";
import { extractWithOllama, pickOllamaModel, probeOllama } from "@/app/lib/ollama";

// ---- the downloadable sample files (match the reconcile engine's expectations) ----
const CONTRACT = {
  name: "contract-PO-4471.txt",
  text: [
    "PURCHASE ORDER PO-4471 — Apex Industrial Supply",
    "SKU | Description | Qty | Unit | Unit Price",
    "BRK-200 | 1/2in steel mounting bracket | 200 | ea | 4.20",
    "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.78",
    "LED-48 | 48in LED shop fixture | 40 | ea | 36.00",
    "CONC-60 | 60lb concrete mix | 120 | bag | 6.50",
    "LBR-INST | installation labor | 80 | hr | 65.00",
  ].join("\n"),
};
const INVOICES = [
  {
    num: "INV-1010",
    label: "INV-1010 — padded (3 overcharges)",
    text: [
      "Apex Industrial Supply — Invoice INV-1010 (PO PO-4471)",
      "SKU | Description | Qty | Unit | Unit Price | Extension",
      "BRK-200 | 1/2in steel mounting bracket | 200 | ea | 4.20 | 840.00",
      "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.95 | 950.00",
      "LED-48 | 48in LED shop fixture | 40 | ea | 44.00 | 1760.00",
      "LBR-INST | installation labor | 80 | hr | 72.00 | 5760.00",
    ].join("\n"),
  },
  {
    num: "INV-1009",
    label: "INV-1009 — clean (no issues)",
    text: [
      "Apex Industrial Supply — Invoice INV-1009 (PO PO-4471)",
      "SKU | Description | Qty | Unit | Unit Price | Extension",
      "BRK-200 | 1/2in steel mounting bracket | 200 | ea | 4.20 | 840.00",
      "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.78 | 780.00",
      "LED-48 | 48in LED shop fixture | 40 | ea | 36.00 | 1440.00",
      "CONC-60 | 60lb concrete mix | 120 | bag | 6.50 | 780.00",
      "LBR-INST | installation labor | 80 | hr | 65.00 | 5200.00",
    ].join("\n"),
  },
  {
    num: "INV-1011",
    label: "INV-1011 — math error + unlisted fee",
    text: [
      "Apex Industrial Supply — Invoice INV-1011 (PO PO-4471)",
      "SKU | Description | Qty | Unit | Unit Price | Extension",
      "CONC-60 | 60lb concrete mix | 120 | bag | 6.50 | 850.00",
      "EXP-FEE | expedite handling fee | 1 | ea | 250.00 | 250.00",
      "BRK-200 | 1/2in steel mounting bracket | 150 | ea | 4.35 | 652.50",
    ].join("\n"),
  },
];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function UploadButton({
  label,
  onText,
  variant = "secondary",
  multiple,
  disabled,
  title,
}: {
  label: string;
  onText: (text: string, filename: string) => void;
  variant?: "primary" | "secondary" | "ghost";
  multiple?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  // A real <button> that opens a hidden file input — so it behaves like every other
  // button (focusable, same hover/press feedback, real disabled state) instead of a
  // <label>, which is what made these read and act inconsistently.
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        disabled={disabled}
        title={title}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept=".txt,.csv,text/plain"
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          for (const f of files) onText(await f.text(), f.name);
          e.target.value = "";
        }}
      />
    </>
  );
}

function Stepper({ step }: { step: number }) {
  const steps = ["Download files", "Upload contract", "Upload invoice", "Review"];
  return (
    <ol className="mb-5 flex flex-wrap gap-2 text-sm">
      {steps.map((s, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "now" : "todo";
        return (
          <li
            key={s}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 ${
              state === "now"
                ? "border-[--color-accent] text-[--color-ink]"
                : state === "done"
                  ? "border-[--color-ok]/50 text-[--color-ok]"
                  : "border-[--color-line] text-[--color-muted]"
            }`}
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full text-xs ${
                state === "done"
                  ? "bg-[--color-ok] text-[--color-accent-ink]"
                  : state === "now"
                    ? "bg-[--color-accent] text-[--color-accent-ink]"
                    : "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)]"
              }`}
            >
              {state === "done" ? "✓" : n}
            </span>
            {s}
          </li>
        );
      })}
    </ol>
  );
}

export default function Dashboard() {
  const { isAuthenticated } = useConvexAuth();
  const baseline = useQuery(api.invoices.baseline);
  const invoices = useQuery(api.invoices.listInvoices);
  const stats = useQuery(api.invoices.stats);
  const demoState = useQuery(api.invoices.demoState);
  const setBaseline = useMutation(api.invoices.setBaselineFromText);
  const createInvoice = useMutation(api.invoices.createInvoiceFromText);
  const reset = useMutation(api.invoices.resetDemo);
  const seedDemoBaseline = useMutation(api.invoices.seedDemoBaseline);
  const runEval = useMutation(api.evals.runEval);
  const routingCfg = useQuery(api.routing.get);
  const submitExtraction = useMutation(api.invoices.submitExtraction);
  const scheduleExtract = useMutation(api.invoices.scheduleExtract);
  const [msg, setMsg] = useState<string | null>(null);
  const seededOnce = useRef(false);

  // Auto-seed the demo set the first time a tenant ever loads the dashboard, so a
  // fresh sign-in lands on a populated walkthrough. Gated on a persistent server
  // flag (demoState.initialized) — NOT on "are there 0 invoices?" — so an explicit
  // Reset stays reset even after navigating away and coming back. The demo invoices
  // are run through the real LLM pipeline (see loadDemo), not pre-baked.
  useEffect(() => {
    if (!seededOnce.current && isAuthenticated && demoState && !demoState.initialized) {
      seededOnce.current = true;
      void loadDemo();
    }
    // loadDemo is stable for our purposes and the ref guards a single run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, demoState]);

  // Run the engine regression (a fixed labeled benchmark, independent of your
  // invoices) asynchronously on app load, so the Evals page is already populated
  // and nobody waits on it. Fire-and-forget; never blocks render.
  const ranEval = useRef(false);
  useEffect(() => {
    if (!ranEval.current && isAuthenticated) {
      ranEval.current = true;
      void runEval().catch(() => {});
    }
  }, [isAuthenticated, runEval]);

  if (!isAuthenticated || baseline === undefined || invoices === undefined) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">connecting your account…</p>
      </main>
    );
  }

  const hasPo = baseline.hasPo;
  const nInv = invoices.length;
  const step = !hasPo ? (nInv === 0 ? 1 : 4) : nInv === 0 ? 3 : 4;

  async function uploadContract(text: string) {
    setMsg(null);
    try {
      const r = await setBaseline({ rawText: text });
      setMsg(`✓ Contract loaded — ${r.poLines} agreed line items are now the baseline.`);
    } catch (e) {
      setMsg("Couldn't read that contract file: " + (e as Error).message);
    }
  }
  async function uploadInvoice(text: string, filename: string) {
    setMsg(null);
    const m = (filename + " " + text).match(/INV-\d+/);
    const invoiceNumber = m?.[0] ?? filename.replace(/\.\w+$/, "");
    const mode = routingCfg?.mode ?? "auto";
    const tryLocal = mode === "auto" || mode === "local";
    let invoiceId;
    try {
      invoiceId = await createInvoice({ invoiceNumber, rawText: text, deferServer: tryLocal });
    } catch (e) {
      setMsg("Upload failed: " + (e as Error).message);
      return;
    }
    if (!tryLocal) {
      setMsg("✓ Uploaded — extracting on the server…");
      return;
    }
    // Host-local Ollama, via the browser (the cloud action can't reach localhost).
    // Prefer it whenever a model is reachable — it has NO quota. We only fall through
    // to the server (paid → free → offline) when no local model is usable, and we say
    // exactly why. Deterministic offline is therefore a true last resort.
    let fellBack = "";
    try {
      const { url: base, models } = await probeOllama();
      if (!base) {
        fellBack = "no local Ollama reachable from the browser";
      } else {
        const model = pickOllamaModel(routingCfg?.model || routingCfg?.defaultLocalModel, models);
        setMsg(`Extracting on your machine via Ollama (${model})…`);
        const t0 = performance.now();
        const lines = await extractWithOllama(text, model, base);
        if (lines.length) {
          await submitExtraction({
            invoiceId,
            provider: "ollama (browser→host)",
            model,
            latencyMs: Math.round(performance.now() - t0),
            lines,
          });
          setMsg(`✓ Extracted on your machine via Ollama (${model}) — no quota used.`);
          return;
        }
        fellBack = `local Ollama (${model}) returned no lines`;
      }
    } catch (e) {
      fellBack = `local Ollama call failed (${(e as Error).message})`;
    }
    await scheduleExtract({ invoiceId });
    setMsg(`⚠ ${fellBack} — using the server (paid → free → offline).`);
  }

  // Load the demo: seed the baseline (PO + catalog) server-side, then run each demo
  // invoice through the SAME extraction pipeline an upload uses — so the demo set is
  // genuinely LLM-extracted (local model via the browser, else server fallback),
  // not pre-reconciled. Used by the first-load auto-seed and the "load everything" button.
  async function loadDemo() {
    setMsg("Loading the demo set through the model…");
    let invoices: { invoiceNumber: string; rawText: string }[] = [];
    try {
      ({ invoices } = await seedDemoBaseline());
    } catch (e) {
      setMsg("Couldn't seed the demo: " + (e as Error).message);
      return;
    }
    for (const inv of invoices) {
      await uploadInvoice(inv.rawText, `invoice-${inv.invoiceNumber}.txt`);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <Nav />
      <h1 className="mb-4 text-lg font-semibold">Invoice verification — guided demo</h1>

      <Stepper step={step} />

      {/* Consistent action bar — the upload controls live here in every step, so they
          never jump around as the walkthrough advances. Reset lives here too. */}
      <section className="glass mb-4 flex flex-wrap items-center gap-2 p-3">
        <UploadButton
          label={hasPo ? "⬆ Replace contract" : "⬆ Upload contract file"}
          onText={uploadContract}
          variant={hasPo ? "secondary" : "primary"}
        />
        <UploadButton
          label="⬆ Upload invoice(s)"
          onText={uploadInvoice}
          multiple
          variant={hasPo && nInv === 0 ? "primary" : "secondary"}
          disabled={!hasPo}
          title={hasPo ? "Upload one or more invoice files" : "Load the contract first"}
        />
        <Button
          variant="secondary"
          className="ml-auto"
          onClick={async () => {
            await reset();
            setMsg("Reset — the demo is cleared. Upload a contract, or reload the sample set below.");
          }}
          title="Clear everything and start the walkthrough over"
        >
          ↻ Reset demo
        </Button>
      </section>

      {msg && (
        <div className="glass mb-4 p-3 text-sm text-[--color-ink]">{msg}</div>
      )}

      {/* STEP 1 + 2: empty — download files, upload the contract */}
      {step === 1 && (
        <div className="space-y-4">
          <section className="glass p-5">
            <h2 className="font-semibold">Step 1 — Download the sample files</h2>
            <p className="mt-1 text-sm text-[--color-muted]">
              Grab a sample <b className="text-[--color-ink]">contract</b> (the agreed purchase order)
              and a few <b className="text-[--color-ink]">invoices</b> from a vendor billed against it.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => download(CONTRACT.name, CONTRACT.text)}>
                ⬇ Download contract (PO)
              </Button>
              {INVOICES.map((inv) => (
                <Button
                  key={inv.num}
                  variant="secondary"
                  onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                >
                  ⬇ {inv.label}
                </Button>
              ))}
            </div>
          </section>
          <section className="glass p-5">
            <h2 className="font-semibold">Step 2 — Upload the contract</h2>
            <p className="mt-1 text-sm text-[--color-muted]">
              Use <b className="text-[--color-ink]">⬆ Upload contract file</b> in the action bar above
              and pick <b className="text-[--color-ink]">contract-PO-4471.txt</b>. It becomes the
              baseline every invoice line is checked against.
            </p>
          </section>
          <div className="flex justify-center">
            <Button variant="secondary" onClick={() => loadDemo()}>
              Skip the walkthrough — load everything
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3: contract loaded, upload an invoice */}
      {step === 3 && (
        <div className="space-y-4">
          <section className="glass p-5">
            <div className="text-[--color-ok]">
              ✓ Baseline loaded — {baseline.poLines} agreed line items from {baseline.poNumber}.
            </div>
          </section>
          <section className="glass p-5">
            <h2 className="font-semibold">Step 3 — Upload an invoice</h2>
            <p className="mt-1 text-sm text-[--color-muted]">
              Use <b className="text-[--color-ink]">⬆ Upload invoice(s)</b> in the action bar above and
              pick one of the <b className="text-[--color-ink]">invoice-INV-….txt</b> files. trueline
              reads it with an LLM, recomputes the math, and checks every line against the contract and
              market rates. Start with the padded one.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[--color-muted]">
              <span>need the files?</span>
              {INVOICES.map((inv) => (
                <Button
                  key={inv.num}
                  variant="secondary"
                  className="px-2.5 py-1 text-xs"
                  onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                >
                  ⬇ {inv.num}
                </Button>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* STEP 4: review */}
      {step === 4 && (
        <>
          <section className="glass mb-4 p-4">
            <p className="text-sm">
              <b>Step 4 — Review.</b> Each invoice below shows its verdict; the{" "}
              <b className="text-[--color-bad]">recoverable</b> figure is money you can dispute.{" "}
              <b className="text-[--color-accent]">Click an invoice</b> to see every line color-coded
              against the contract.
            </p>
          </section>

          {/* These three reflect YOUR invoices. Engine accuracy (precision/recall)
              lives on the Evals page — it's a fixed benchmark, not a per-invoice stat. */}
          <section className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Invoices" value={String(stats?.invoices ?? nInv)} />
            <Stat label="Recoverable" value={usd(stats?.recoverableUsd)} accent />
            <Stat label="Needs review" value={String(stats?.needsReview ?? 0)} />
          </section>

          <div className="grid gap-6 md:grid-cols-[1fr_300px]">
            <section className="space-y-2">
              {invoices.map((inv) => (
                <Link
                  key={inv._id}
                  href={`/app/invoices/${inv._id}`}
                  className="glass flex items-center gap-3 p-3 transition-colors hover:border-[--color-accent]/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{inv.invoiceNumber}</span>
                      <StatusBadge status={inv.status} />
                    </div>
                    <div className={`mt-0.5 text-xs ${verdictCls(inv)}`}>{verdictText(inv)}</div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    {inv.red > 0 && <FlagBadge flag="red" />}
                    {inv.yellow > 0 && <FlagBadge flag="yellow" />}
                    {inv.green > 0 && <FlagBadge flag="green" />}
                  </div>
                  <div className="w-24 text-right">
                    <div className="text-xs text-[--color-muted]">recoverable</div>
                    <div
                      className={inv.recoverableUsd ? "font-semibold text-[--color-bad]" : "text-[--color-muted]"}
                    >
                      {usd(inv.recoverableUsd)}
                    </div>
                  </div>
                </Link>
              ))}
            </section>

            <aside className="space-y-4">
              <section className="glass p-4">
                <h2 className="mb-1 text-sm font-semibold">Add another invoice</h2>
                <p className="text-xs text-[--color-muted]">
                  Use <b className="text-[--color-ink]">⬆ Upload invoice(s)</b> in the action bar above.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[--color-muted]">
                  <span>need a sample?</span>
                  {INVOICES.map((inv) => (
                    <Button
                      key={inv.num}
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                    >
                      ⬇ {inv.num}
                    </Button>
                  ))}
                </div>
              </section>
              <section className="glass p-4">
                <h2 className="mb-1 text-sm font-semibold">Engine regression</h2>
                <p className="mb-3 text-xs text-[--color-muted]">
                  Flag precision/recall are scored on a fixed labeled benchmark — independent of these
                  invoices. It runs automatically; full results live on the Evals page.
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1 px-3 py-1.5" onClick={() => runEval()}>
                    Re-run
                  </Button>
                  <Link href="/app/evals" className={buttonCls("secondary", "flex-1 px-3 py-1.5")}>
                    View Evals
                  </Link>
                </div>
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass p-3">
      <div className="text-xs text-[--color-muted]">{label}</div>
      <div className={`text-xl font-semibold ${accent ? "text-[--color-bad]" : ""}`}>{value}</div>
    </div>
  );
}

type InvRow = {
  red: number;
  yellow: number;
  green: number;
  lineCount: number;
  recoverableUsd?: number | null;
  status: string;
};
function verdictText(inv: InvRow): string {
  if (inv.status === "extracting") return "extracting line items…";
  if (inv.red > 0)
    return `${inv.red} overcharge${inv.red > 1 ? "s" : ""} found · ${usd(inv.recoverableUsd)} to dispute`;
  if (inv.yellow > 0) return `${inv.yellow} line${inv.yellow > 1 ? "s" : ""} to review`;
  if (inv.lineCount > 0) return "clean — every line within PO & market";
  return "";
}
function verdictCls(inv: InvRow): string {
  if (inv.red > 0) return "text-[--color-bad] font-medium";
  if (inv.yellow > 0) return "text-[--color-warn]";
  return "text-[--color-ok]";
}
