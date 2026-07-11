// scripts/metrics-poll.ts — STANDALONE observability metrics poll (backstop).
//
// The worker's maybePollMetrics() sweep is the primary. This thin entrypoint
// calls the SAME pollAndIngest() once and exits, so an EXTERNAL cron (or a human)
// can force a poll if the worker is down — same code, two entrypoints, no logic
// duplication. Mirrors scripts/auto-refresh.ts.
//
// Unlike the worker sweep it is NOT flag-gated: invoking this script is itself
// the opt-in (you only run it when you want a poll). It still degrades cleanly —
// absent Mongo → the ingest reports degraded and the run exits 0 (nothing to
// push), absent a provider's creds → that poller contributes 0 points.
//
// Run (Node >= 20; loads secrets from .env.local):
//   node --experimental-strip-types --env-file=.env.local scripts/metrics-poll.ts [--dry-run]
//
// Cron example (every minute — the same cadence the worker sweep uses):
//   * * * * *  cd flotilla && node --experimental-strip-types \
//     --env-file=.env.local scripts/metrics-poll.ts

import { pathToFileURL } from "node:url";
import { pollAndIngest, collectMetrics } from "../lib/observability/collect.ts";

export type MetricsPollArgs = { dryRun: boolean; backfill: boolean };

export function parseArgs(argv: string[]): MetricsPollArgs {
  const a: MetricsPollArgs = { dryRun: false, backfill: false };
  for (const t of argv) {
    if (t === "--dry-run") a.dryRun = true;
    // Force the DEEP backfill this run regardless of the gate marker (parity with
    // the poll route's ?backfill=1). Without it the marker-backed gate decides.
    else if (t === "--backfill") a.backfill = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
  }
  return a;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: MetricsPollArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const log = (m: string) => console.log(`[metrics-poll] ${m}`);

  // --dry-run: collect + cap but DON'T push to the store (useful to eyeball what
  // the pollers produce without needing/writing to a store). --backfill forces the
  // deep window; otherwise dry-run uses the default recent window.
  if (args.dryRun) {
    const r = await collectMetrics({ log, mode: args.backfill ? "backfill" : undefined });
    log(`dry-run [${args.backfill ? "backfill" : "recent"}]: ${r.points.length} point(s) collected (${JSON.stringify(r.byProvider)}), ${r.dropped} dropped`);
    return 0;
  }

  const r = await pollAndIngest({ log, forceBackfill: args.backfill });
  log(
    `[${r.mode}] collected ${r.points.length} point(s) (${JSON.stringify(r.byProvider)}); ` +
      (r.ingest.degraded
        ? `ingest degraded — ${r.ingest.reason ?? "unknown"}`
        : `ingested ${r.ingest.ingested} to the metrics store`),
  );
  // Degraded ingest is not a failure of THIS script — the poll ran fine; the
  // store just isn't reachable yet. Exit 0 so a cron doesn't alarm on a store blip.
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
