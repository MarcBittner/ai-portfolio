"use client";

import { useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";
import { usd } from "@/app/components/ui";

const BENCH_SAMPLE = [
  "Apex Industrial Supply — Invoice INV-BENCH (PO PO-4471)",
  "SKU | Description | Qty | Unit | Unit Price | Extension",
  "CBL-12G | 12 AWG copper cable | 1000 | ft | 0.95 | 950.00",
  "LED-48 | 48in LED shop fixture | 40 | ea | 44.00 | 1760.00",
  "LBR-INST | installation labor | 80 | hr | 72.00 | 5760.00",
].join("\n");

type BenchRow = {
  mode: string;
  provider: string;
  model: string;
  latencyMs: number;
  lines: number;
  error: string | null;
};

export default function Diagnostics() {
  const { isAuthenticated } = useConvexAuth();
  const invoices = useQuery(api.invoices.listInvoices);
  const logs = useQuery(api.invoices.recentLogs);
  const benchmark = useAction(api.diagnostics.benchmark);
  const [bench, setBench] = useState<BenchRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isAuthenticated || invoices === undefined || logs === undefined) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">connecting…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Nav />
      <h1 className="text-lg font-semibold">Diagnostics</h1>
      <p className="mb-5 mt-1 text-sm text-[--color-muted]">
        Request traces, the event log, and a model benchmark — the technical view behind the
        product.
      </p>

      {/* model benchmark */}
      <section className="glass p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Model benchmark</div>
            <div className="text-xs text-[--color-muted]">
              Run one invoice through every routing mode and compare provider, latency, and lines
              recovered.
            </div>
          </div>
          <button
            onClick={async () => {
              setBusy(true);
              try {
                setBench(await benchmark({ invoiceText: BENCH_SAMPLE }));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="rounded-md bg-[--color-accent] px-4 py-2 text-sm font-medium text-[--color-accent-ink] disabled:opacity-50"
          >
            {busy ? "benchmarking…" : "Run benchmark"}
          </button>
        </div>
        {bench && (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs uppercase text-[--color-muted]">
              <tr className="border-b border-[--color-line]">
                <th className="p-2">Mode</th>
                <th className="p-2">Resolved provider</th>
                <th className="p-2">Model</th>
                <th className="p-2">Latency</th>
                <th className="p-2">Lines</th>
              </tr>
            </thead>
            <tbody>
              {bench.map((r) => (
                <tr key={r.mode} className="border-b border-[--color-line]/50">
                  <td className="p-2 font-medium">{r.mode}</td>
                  <td className="p-2">{r.provider}</td>
                  <td className="p-2 text-xs">{r.model}</td>
                  <td className="p-2">{(r.latencyMs / 1000).toFixed(2)}s</td>
                  <td className="p-2">{r.error ? <span className="text-[--color-bad]">err</span> : r.lines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* request traces */}
      <section className="glass mt-4 overflow-x-auto p-1">
        <div className="px-4 pt-3 text-sm font-semibold">Request traces — extraction runs</div>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs uppercase text-[--color-muted]">
            <tr className="border-b border-[--color-line]">
              <th className="p-3">Invoice</th>
              <th className="p-3">Provider / model</th>
              <th className="p-3">Latency</th>
              <th className="p-3">Cost</th>
              <th className="p-3">Lines</th>
              <th className="p-3">Flags</th>
              <th className="p-3">When</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 && (
              <tr>
                <td className="p-3 text-[--color-muted]" colSpan={7}>
                  No runs yet — upload an invoice on the dashboard.
                </td>
              </tr>
            )}
            {invoices.map((inv) => (
              <tr key={inv._id} className="border-b border-[--color-line]/50">
                <td className="p-3 font-medium">{inv.invoiceNumber}</td>
                <td className="p-3 text-xs">
                  {inv.extractionProvider ?? "—"}
                  {inv.extractionModel ? ` / ${inv.extractionModel.split("/").pop()}` : ""}
                </td>
                <td className="p-3">{inv.latencyMs != null ? `${(inv.latencyMs / 1000).toFixed(2)}s` : "—"}</td>
                <td className="p-3">{inv.costUsd != null ? (inv.costUsd === 0 ? "$0" : usd(inv.costUsd)) : "—"}</td>
                <td className="p-3">{inv.lineCount}</td>
                <td className="p-3 text-xs">
                  <span className="text-[--color-bad]">{inv.red}r</span>{" "}
                  <span className="text-[--color-warn]">{inv.yellow}y</span>{" "}
                  <span className="text-[--color-ok]">{inv.green}g</span>
                </td>
                <td className="p-3 text-xs text-[--color-muted]">
                  {new Date(inv._creationTime).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* event log */}
      <section className="glass mt-4 p-4">
        <div className="text-sm font-semibold">Event log</div>
        <div className="mt-2 max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
          {logs.length === 0 && <div className="text-[--color-muted]">no events yet</div>}
          {logs.map((l) => (
            <div key={l._id} className="flex gap-2">
              <span className="text-[--color-muted]">
                {new Date(l._creationTime).toLocaleTimeString()}
              </span>
              <span
                style={{
                  color:
                    l.level === "error" ? "#f15b6c" : l.level === "warn" ? "#e6ad52" : "#43c98a",
                }}
              >
                {l.level}
              </span>
              <span className="text-[--color-accent]">{l.event}</span>
              <span className="text-[--color-ink]">{l.detail}</span>
              {l.latencyMs != null && <span className="text-[--color-muted]">{l.latencyMs}ms</span>}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
