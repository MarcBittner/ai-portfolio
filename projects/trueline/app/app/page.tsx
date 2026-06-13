"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";
import { FlagBadge, StatusBadge, usd } from "@/app/components/ui";

const SAMPLE = [
  "Apex Industrial Supply — Invoice INV-2042 (PO PO-4471)",
  "SKU | Description | Qty | Unit | Unit Price | Extension",
  "LED-48 | 48in LED shop fixture | 40 | ea | 47.00 | 1880.00",
  "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.98 | 980.00",
  "RUSH-FEE | rush processing fee | 1 | ea | 400.00 | 400.00",
].join("\n");

export default function Dashboard() {
  const seed = useMutation(api.invoices.seedIfEmpty);
  const stats = useQuery(api.invoices.stats);
  const invoices = useQuery(api.invoices.listInvoices);
  const create = useMutation(api.invoices.createInvoiceFromText);
  const runEval = useMutation(api.evals.runEval);

  const [num, setNum] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (isAuthenticated) seed().catch(() => {});
  }, [isAuthenticated, seed]);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await create({
        invoiceNumber: num.trim() || `INV-${Math.floor(1000 + Math.random() * 9000)}`,
        rawText: text.trim(),
      });
      setNum("");
      setText("");
    } finally {
      setBusy(false);
    }
  }

  const eval0 = stats?.latestEval;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <Nav />

      <section className="glass mb-4 p-4 text-sm">
        <div className="font-semibold">What you're looking at</div>
        <p className="mt-1 text-[--color-muted]">
          Each row below is a <b className="text-[--color-ink]">vendor invoice</b>. trueline read it
          with an LLM, then <b className="text-[--color-ink]">re-computed every line in code</b> and
          checked each charge against the agreed purchase order (PO-4471) and market rates.{" "}
          <span className="whitespace-nowrap">🔴 overcharge</span> ·{" "}
          <span className="whitespace-nowrap">🟡 needs a look</span> ·{" "}
          <span className="whitespace-nowrap">🟢 within tolerance</span>. The{" "}
          <b className="text-[--color-ink]">recoverable</b> figure is money you can dispute.
        </p>
        <p className="mt-2 text-[--color-accent]">
          👉 New here? Open <b>INV-1010</b> — a padded bill with ~$1,090 in overcharges.
        </p>
        <button
          onClick={() => seed()}
          className="mt-3 rounded-md border border-[--color-line] px-3 py-1.5 text-sm hover:border-[--color-accent]"
        >
          Load sample invoices
        </button>
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        <Stat label="Invoices" value={stats ? String(stats.invoices) : "—"} />
        <Stat label="Recoverable" value={stats ? usd(stats.recoverableUsd) : "—"} accent />
        <Stat label="Needs review" value={stats ? String(stats.needsReview) : "—"} />
        <Stat
          label="Flag P / R"
          value={eval0 ? `${eval0.flagPrecision.toFixed(2)} / ${eval0.flagRecall.toFixed(2)}` : "run eval"}
        />
      </section>

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_320px]">
        {/* invoice list */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[--color-muted]">
            Invoices
          </h2>
          <div className="space-y-2">
            {invoices === undefined && <p className="text-sm text-[--color-muted]">loading…</p>}
            {invoices?.length === 0 && (
              <p className="text-sm text-[--color-muted]">seeding demo data…</p>
            )}
            {invoices?.map((inv) => (
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
                  <div className="text-xs text-[--color-muted]">
                    {inv.vendor} · {inv.lineCount} lines · claimed {usd(inv.claimedTotal)}
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
                  <div className={inv.recoverableUsd ? "font-semibold text-[--color-bad]" : "text-[--color-muted]"}>
                    {usd(inv.recoverableUsd)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* upload + eval */}
        <aside className="space-y-6">
          <section className="glass p-4">
            <h2 className="mb-2 text-sm font-semibold">New invoice</h2>
            <p className="mb-3 text-xs text-[--color-muted]">
              Paste invoice text; an action extracts it with the LLM, then deterministic code
              verifies + reconciles it against the PO and catalog.
            </p>
            <input
              value={num}
              onChange={(e) => setNum(e.target.value)}
              placeholder="Invoice # (optional)"
              className="mb-2 w-full rounded-md border border-[--color-line] bg-black/20 px-3 py-2 text-sm"
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste invoice lines…"
              rows={6}
              className="w-full rounded-md border border-[--color-line] bg-black/20 px-3 py-2 font-mono text-xs"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={submit}
                disabled={busy || !text.trim()}
                className="rounded-md bg-[--color-accent] px-3 py-1.5 text-sm font-medium text-[--color-accent-ink] disabled:opacity-50"
              >
                {busy ? "submitting…" : "Verify invoice"}
              </button>
              <button
                onClick={() => setText(SAMPLE)}
                className="rounded-md border border-[--color-line] px-3 py-1.5 text-sm"
              >
                Load sample
              </button>
            </div>
          </section>

          <section className="glass p-4">
            <h2 className="mb-2 text-sm font-semibold">Evaluation</h2>
            <p className="mb-3 text-xs text-[--color-muted]">
              Score the flag engine on the labeled set (the CI gate before shipping a change).
            </p>
            {eval0 && (
              <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
                <EvalCell k="precision" v={eval0.flagPrecision} />
                <EvalCell k="recall" v={eval0.flagRecall} />
                <EvalCell k="math-ok" v={eval0.extractionAccuracy} />
              </div>
            )}
            <button
              onClick={() => runEval()}
              className="w-full rounded-md border border-[--color-line] px-3 py-1.5 text-sm"
            >
              Run eval
            </button>
          </section>
        </aside>
      </div>
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

function EvalCell({ k, v }: { k: string; v: number }) {
  return (
    <div className="rounded-md bg-black/20 p-2">
      <div className="text-[--color-muted]">{k}</div>
      <div className="text-base font-semibold">{v.toFixed(2)}</div>
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
