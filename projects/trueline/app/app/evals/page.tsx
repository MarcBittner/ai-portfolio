"use client";

import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";
import { Button } from "@/app/components/ui";

export default function Evals() {
  const { isAuthenticated } = useConvexAuth();
  const runs = useQuery(api.evals.listEvals);
  const stats = useQuery(api.invoices.stats);
  const runEval = useMutation(api.evals.runEval);
  const [busy, setBusy] = useState(false);

  // The benchmark also auto-runs on the dashboard at app load; run it here too in
  // case this is the first page the user lands on. Idempotent + deduped server-side,
  // so a fresh run only appends a row when the engine's numbers actually changed.
  const ranEval = useRef(false);
  useEffect(() => {
    if (!ranEval.current && isAuthenticated) {
      ranEval.current = true;
      void runEval({}).catch(() => {});
    }
  }, [isAuthenticated, runEval]);

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
        Two different things are measured here, and they don&apos;t mix. <b>Engine regression</b> is the
        CI gate — it scores the flag engine against a fixed, hand-labeled benchmark built into the
        code, so it&apos;s <i>independent of anything you upload</i>. <b>Your data</b> is a live readout of
        the invoices you&apos;ve actually processed.
      </p>

      {/* action bar — its own row, kept separate from the metrics themselves */}
      <section className="glass mb-4 flex flex-wrap items-center justify-between gap-3 p-3">
        <span className="text-xs text-[--color-muted]">
          The regression runs automatically on load. Re-run it after an engine change.
        </span>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await runEval({ force: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "scoring…" : "Re-run evaluation"}
        </Button>
      </section>

      {/* ---- engine regression: the fixed benchmark, independent of uploads ---- */}
      <section className="glass p-5">
        <div className="text-sm font-semibold">Engine regression — the CI gate</div>
        <div className="text-xs text-[--color-muted]">
          Scored on a fixed, hand-labeled benchmark of 18 invoices. These move only when the
          <i> engine</i> changes — never when you upload.
        </div>
        {latest ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric label="Flag precision" v={latest.flagPrecision} hint="of flagged, how many were real overcharges" />
            <Metric label="Flag recall" v={latest.flagRecall} hint="of real overcharges, how many it caught" />
          </div>
        ) : (
          <p className="mt-4 text-sm text-[--color-muted]">
            Scoring the benchmark… (runs automatically on load).
          </p>
        )}
        <p className="mt-3 text-xs text-[--color-muted]">
          A <b className="text-[--color-bad]">false negative</b> lets padding through (lost money); a{" "}
          <b className="text-[--color-warn]">false positive</b> makes estimators stop trusting it. This
          is the gate you&apos;d run before shipping a threshold, prompt, or model change.
        </p>
      </section>

      {/* ---- your data: a live property of what you've processed ---- */}
      <section className="glass mt-4 p-5">
        <div className="text-sm font-semibold">Your processed invoices</div>
        <div className="text-xs text-[--color-muted]">
          A live readout of the invoices you&apos;ve uploaded — this changes as you process more.
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Metric
            label="Math-consistency"
            v={stats?.mathConsistency ?? null}
            hint="of your lines, the share whose printed total checks out"
          />
          <div className="rounded-lg border border-[--color-line] p-3">
            <div className="text-xs text-[--color-muted]">Lines processed</div>
            <div className="text-2xl font-bold">{stats?.linesProcessed ?? 0}</div>
            <div className="mt-1 text-xs text-[--color-muted]">across your uploaded invoices</div>
          </div>
        </div>
      </section>

      {runs.length > 0 && (
        <section className="glass mt-4 overflow-x-auto p-1">
          <div className="px-4 pt-3 text-sm font-semibold">Regression history</div>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase text-[--color-muted]">
              <tr className="border-b border-[--color-line]">
                <th className="p-3">When</th>
                <th className="p-3">Engine</th>
                <th className="p-3">N</th>
                <th className="p-3">Precision</th>
                <th className="p-3">Recall</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function Metric({ label, v, hint }: { label: string; v: number | null; hint: string }) {
  if (v === null) {
    return (
      <div className="rounded-lg border border-[--color-line] p-3">
        <div className="text-xs text-[--color-muted]">{label}</div>
        <div className="text-2xl font-bold text-[--color-muted]">—</div>
        <div className="mt-1 text-xs text-[--color-muted]">{hint}</div>
      </div>
    );
  }
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
