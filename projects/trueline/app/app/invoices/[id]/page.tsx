"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Nav } from "@/app/components/nav";
import { FlagBadge, StatusBadge, usd } from "@/app/components/ui";

export default function InvoiceReview() {
  const params = useParams();
  const invoiceId = params.id as Id<"invoices">;
  const data = useQuery(api.invoices.getInvoice, { invoiceId });
  const reviewLine = useMutation(api.invoices.reviewLine);
  const correctLine = useMutation(api.invoices.correctLine);
  const setStatus = useMutation(api.invoices.setInvoiceStatus);

  if (data === undefined)
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">loading…</p>
      </main>
    );
  if (data === null)
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">Not found.</p>
        <Link href="/app" className="text-[--color-accent]">← back</Link>
      </main>
    );

  const { invoice, lines } = data;
  const recoverable = lines.reduce((s, l) => s + l.recoverableUsd, 0);

  async function correct(lineId: Id<"invoiceLines">, current: number) {
    const v = window.prompt("Corrected unit price:", String(current));
    if (v === null) return;
    const n = parseFloat(v);
    if (Number.isFinite(n)) await correctLine({ lineId, unitPrice: n });
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/app" className="text-sm text-[--color-muted] hover:text-[--color-ink]">
          ← invoices
        </Link>
        <h1 className="text-xl font-semibold">{invoice.invoiceNumber}</h1>
        <StatusBadge status={invoice.status} />
        <span className="text-sm text-[--color-muted]">
          {invoice.vendor} · vs {invoice.poNumber} · extracted by{" "}
          {invoice.extractionProvider}/{invoice.extractionModel}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-[--color-muted]">recoverable</div>
            <div className="font-semibold text-[--color-bad]">{usd(recoverable)}</div>
          </div>
          <button
            onClick={() => setStatus({ invoiceId, status: "approved" })}
            className="rounded-md bg-[--color-ok]/20 px-3 py-1.5 text-sm font-medium text-[--color-ok]"
          >
            Approve invoice
          </button>
          <button
            onClick={() => setStatus({ invoiceId, status: "rejected" })}
            className="rounded-md bg-[--color-bad]/20 px-3 py-1.5 text-sm font-medium text-[--color-bad]"
          >
            Reject
          </button>
        </div>
      </div>

      {invoice.status === "extracting" && (
        <p className="glass p-3 text-sm text-[--color-muted]">
          Extracting line items… this view updates live when the action finishes.
        </p>
      )}

      <div className="glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-[--color-muted]">
            <tr className="border-b border-[--color-line]">
              <th className="p-3">Line</th>
              <th className="p-3">Qty × Unit</th>
              <th className="p-3">Claimed</th>
              <th className="p-3">Computed</th>
              <th className="p-3">PO</th>
              <th className="p-3">Catalog</th>
              <th className="p-3">Variance</th>
              <th className="p-3">Conf.</th>
              <th className="p-3">Flag</th>
              <th className="p-3">Decision</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l._id} className="border-b border-[--color-line]/50 align-top">
                <td className="p-3">
                  <div className="font-medium">{l.description}</div>
                  <div className="text-xs text-[--color-muted]">
                    {l.sku ?? "no sku"} · matched by {l.matchedBy}
                  </div>
                  <div className="mt-1 max-w-xs text-xs italic text-[--color-muted]">“{l.sourceQuote}”</div>
                  {l.reasons.length > 0 && (
                    <ul className="mt-1 text-xs text-[--color-muted]">
                      {l.reasons.map((r, i) => (
                        <li key={i}>· {r}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="p-3 whitespace-nowrap">
                  {l.quantity} {l.unit} × {usd(l.unitPrice)}
                </td>
                <td className="p-3 whitespace-nowrap">{usd(l.claimedExtension)}</td>
                <td className={`p-3 whitespace-nowrap ${l.mathOk ? "" : "text-[--color-bad]"}`}>
                  {usd(l.computedExtension)}
                  {!l.mathOk && <span className="ml-1 text-xs">math!</span>}
                </td>
                <td className="p-3 whitespace-nowrap">{usd(l.poUnitPrice)}</td>
                <td className="p-3 whitespace-nowrap">{usd(l.catalogPrice)}</td>
                <td className="p-3 whitespace-nowrap">
                  {l.varianceVsPoPct !== undefined ? `${l.varianceVsPoPct > 0 ? "+" : ""}${l.varianceVsPoPct}%` : "—"}
                </td>
                <td className="p-3">{(l.confidence * 100).toFixed(0)}%</td>
                <td className="p-3">
                  <FlagBadge flag={l.flag} />
                  {l.recoverableUsd > 0 && (
                    <div className="mt-1 text-xs text-[--color-bad]">{usd(l.recoverableUsd)}</div>
                  )}
                </td>
                <td className="p-3">
                  {l.decision !== "pending" ? (
                    <span className="text-xs text-[--color-muted]">{l.decision}</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => reviewLine({ lineId: l._id, decision: "approved" })}
                        className="rounded bg-[--color-ok]/15 px-2 py-0.5 text-xs text-[--color-ok]"
                      >
                        approve
                      </button>
                      <button
                        onClick={() => correct(l._id, l.unitPrice)}
                        className="rounded bg-white/5 px-2 py-0.5 text-xs"
                      >
                        correct
                      </button>
                      <button
                        onClick={() => reviewLine({ lineId: l._id, decision: "rejected" })}
                        className="rounded bg-[--color-bad]/15 px-2 py-0.5 text-xs text-[--color-bad]"
                      >
                        reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
