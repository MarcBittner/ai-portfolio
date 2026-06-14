"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";

export default function Evals() {
  const { isAuthenticated } = useConvexAuth();
  const runs = useQuery(api.evals.listEvals);
  const runEval = useMutation(api.evals.runEval);
  const [busy, setBusy] = useState(false);

  if (!isAuthenticated || runs === undefined) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">connecting…</p>
      </main>
    );
  }
  const latest = runs[0];

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Nav />
      <h1 className="text-lg font-semibold">Evaluation — proving the engine before it ships</h1>
      <p className="mb-5 mt-1 text-sm text-[--color-muted]">
        Accuracy is <i>measured</i>, not asserted. This scores the flag engine on a labeled set of
        invoices — the gate you'd run in CI before shipping a threshold, prompt, or model change. A{" "}
        <b className="text-[--color-bad]">false negative</b> lets padding through (lost money); a{" "}
        <b className="text-[--color-warn]">false positive</b> makes estimators stop trusting it.
      </p>

      <section className="glass p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Latest run</div>
          <button
            onClick={async () => {
              setBusy(true);
              try {
                await runEval();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="rounded-md bg-[--color-accent] px-4 py-2 text-sm font-medium text-[--color-accent-ink] disabled:opacity-50"
          >
            {busy ? "scoring…" : "Run evaluation"}
          </button>
        </div>
        {latest ? (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Metric label="Flag precision" v={latest.flagPrecision} hint="of flagged, how many were real" />
            <Metric label="Flag recall" v={latest.flagRecall} hint="of real issues, how many caught" />
            <Metric label="Math-consistency" v={latest.extractionAccuracy} hint="lines whose totals check out" />
          </div>
        ) : (
          <p className="mt-4 text-sm text-[--color-muted]">
            No runs yet — upload the sample invoices on the dashboard, then run the evaluation.
          </p>
        )}
      </section>

      {runs.length > 0 && (
        <section className="glass mt-4 overflow-x-auto p-1">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[--color-muted]">
              <tr className="border-b border-[--color-line]">
                <th className="p-3">When</th>
                <th className="p-3">Engine</th>
                <th className="p-3">N</th>
                <th className="p-3">Precision</th>
                <th className="p-3">Recall</th>
                <th className="p-3">Math-consistency</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r._id} className="border-b border-[--color-line]/50">
                  <td className="p-3">{new Date(r._creationTime).toLocaleString()}</td>
                  <td className="p-3">{r.model}</td>
                  <td className="p-3">{r.n}</td>
                  <td className="p-3">{r.flagPrecision.toFixed(2)}</td>
                  <td className="p-3">{r.flagRecall.toFixed(2)}</td>
                  <td className="p-3">{r.extractionAccuracy.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function Metric({ label, v, hint }: { label: string; v: number; hint: string }) {
  const color =
    v >= 0.9
      ? "var(--color-ok)"
      : v >= 0.7
        ? "var(--color-warn)"
        : "var(--color-bad)";
  return (
    <div className="rounded-lg border border-[--color-line] p-3">
      <div className="text-xs text-[--color-muted]">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>
        {(v * 100).toFixed(0)}%
      </div>
      <div className="mt-1 text-xs text-[--color-muted]">{hint}</div>
    </div>
  );
}
