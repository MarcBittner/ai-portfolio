"use client";

import { useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";
import { FlagBadge, StatusBadge, usd } from "@/app/components/ui";

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
  primary,
  multiple,
}: {
  label: string;
  onText: (text: string, filename: string) => void;
  primary?: boolean;
  multiple?: boolean;
}) {
  return (
    <label
      className={`inline-block cursor-pointer rounded-md px-4 py-2 text-sm font-medium ${
        primary
          ? "bg-[--color-accent] text-[--color-accent-ink]"
          : "border border-[--color-line] hover:border-[--color-accent]"
      }`}
    >
      {label}
      <input
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
    </label>
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
                    : "bg-white/10"
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
  const setBaseline = useMutation(api.invoices.setBaselineFromText);
  const createInvoice = useMutation(api.invoices.createInvoiceFromText);
  const reset = useMutation(api.invoices.resetDemo);
  const seedAll = useMutation(api.invoices.seedIfEmpty);
  const runEval = useMutation(api.evals.runEval);
  const [msg, setMsg] = useState<string | null>(null);

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
    try {
      await createInvoice({ invoiceNumber: m?.[0] ?? filename.replace(/\.\w+$/, ""), rawText: text });
      setMsg("✓ Invoice uploaded — extracting + reconciling now…");
    } catch (e) {
      setMsg("Upload failed: " + (e as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <Nav />
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Invoice verification — guided demo</h1>
        <button
          onClick={async () => {
            await reset();
            setMsg("Reset — start from step 1.");
          }}
          className="rounded-md border border-[--color-line] px-3 py-1.5 text-xs text-[--color-muted] hover:border-[--color-accent]"
          title="Clear everything and start the walkthrough over"
        >
          ↻ Reset demo
        </button>
      </div>

      <Stepper step={step} />
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
              <button
                onClick={() => download(CONTRACT.name, CONTRACT.text)}
                className="rounded-md bg-[--color-accent] px-4 py-2 text-sm font-medium text-[--color-accent-ink]"
              >
                ⬇ Download contract (PO)
              </button>
              {INVOICES.map((inv) => (
                <button
                  key={inv.num}
                  onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                  className="rounded-md border border-[--color-line] px-4 py-2 text-sm hover:border-[--color-accent]"
                >
                  ⬇ {inv.label}
                </button>
              ))}
            </div>
          </section>
          <section className="glass p-5">
            <h2 className="font-semibold">Step 2 — Upload the contract</h2>
            <p className="mt-1 text-sm text-[--color-muted]">
              Upload <b className="text-[--color-ink]">contract-PO-4471.txt</b>. It becomes the baseline
              every invoice line is checked against.
            </p>
            <div className="mt-3">
              <UploadButton label="⬆ Upload contract file" onText={uploadContract} primary />
            </div>
          </section>
          <p className="text-center text-xs text-[--color-muted]">
            or{" "}
            <button onClick={() => seedAll()} className="text-[--color-accent] underline">
              skip the walkthrough and load everything
            </button>
          </p>
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
              Upload one of the <b className="text-[--color-ink]">invoice-INV-….txt</b> files. trueline
              will read it with an LLM, recompute the math, and check every line against the contract
              and market rates. Start with the padded one.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <UploadButton label="⬆ Upload invoice file(s)" onText={uploadInvoice} primary multiple />
              <span className="text-xs text-[--color-muted]">
                (need the files?{" "}
                {INVOICES.map((inv, i) => (
                  <button
                    key={inv.num}
                    onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                    className="text-[--color-accent] underline"
                  >
                    {inv.num}
                    {i < INVOICES.length - 1 ? ", " : ""}
                  </button>
                ))}
                )
              </span>
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

          <section className="mb-4 grid gap-3 sm:grid-cols-4">
            <Stat label="Invoices" value={String(stats?.invoices ?? nInv)} />
            <Stat label="Recoverable" value={usd(stats?.recoverableUsd)} accent />
            <Stat label="Needs review" value={String(stats?.needsReview ?? 0)} />
            <Stat
              label="Flag P / R"
              value={
                stats?.latestEval
                  ? `${stats.latestEval.flagPrecision.toFixed(2)} / ${stats.latestEval.flagRecall.toFixed(2)}`
                  : "run eval"
              }
            />
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
                <h2 className="mb-2 text-sm font-semibold">Add another invoice</h2>
                <UploadButton label="⬆ Upload invoice(s)" onText={uploadInvoice} multiple />
                <div className="mt-2 text-xs text-[--color-muted]">
                  {INVOICES.map((inv, i) => (
                    <button
                      key={inv.num}
                      onClick={() => download(`invoice-${inv.num}.txt`, inv.text)}
                      className="text-[--color-accent] underline"
                    >
                      {inv.num}
                      {i < INVOICES.length - 1 ? " · " : ""}
                    </button>
                  ))}
                </div>
              </section>
              <section className="glass p-4">
                <h2 className="mb-2 text-sm font-semibold">Evaluation</h2>
                <p className="mb-2 text-xs text-[--color-muted]">
                  Score the flag engine (precision/recall) on the labeled set.
                </p>
                <button
                  onClick={() => runEval()}
                  className="w-full rounded-md border border-[--color-line] px-3 py-1.5 text-sm"
                >
                  Run eval
                </button>
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
