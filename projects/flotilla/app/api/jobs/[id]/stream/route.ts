import { getPrincipal } from "@/lib/auth";
import { bad } from "@/lib/api";
import { getJob, queryLogs, type LogDoc, type JobDoc } from "@/lib/models";
import { db, COLLECTIONS } from "@/lib/mongo";
import type { ChangeStream, ChangeStreamDocument } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["succeeded", "failed", "rolled_back"]);
const MAX_MS = 300_000; // ~5 min guard so a hung job can't stream forever (matches the old 300-tick guard).
const POLL_MS = 1000; // fallback poll cadence (unchanged from the pre-change-stream behavior).

// GET /api/jobs/:id/stream — Server-Sent Events: pushes new log lines + status as
// the job runs, closing when the job reaches a terminal state (B-4 "live job log").
// Falls back gracefully — the polling GET on the same id is always valid.
//
// PERF-P2: the stream is now driven by a MongoDB CHANGE STREAM watching this job's
// log inserts + status updates, instead of re-reading getJob()+queryLogs() every
// second. On standalone Mongo (no oplog → change streams unsupported) it FALLS BACK
// to the original 1 s poll. The SSE contract is byte-for-byte identical either way:
//   event: log    → one LogDoc                (per new log line, oldest→newest)
//   event: status → { status, url }           (on each job-status change)
//   event: done   → { status }                (once, when terminal; then close)
//   event: error  → { message }               (best-effort; never terminal by itself)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Authenticate before opening the stream (no job data reaches an unauthenticated
  // caller). Uses bad() for the same JSON {error} 401 shape as every other route
  // [API-3]. SSE returns a stream body, so it can't wrap in withOperator directly;
  // the floor here is the same "authenticated operator" as withOperator's default.
  if (!(await getPrincipal())) return bad("unauthorized", 401);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let since = 0;
      let lastStatus: string | undefined;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // controller already closed (client disconnected)
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Emit any not-yet-seen logs (since `since`) in order, advancing `since`.
      const drainLogs = async () => {
        const logs = await queryLogs({ jobId: id, since });
        for (const l of logs) {
          send("log", l);
          since = Math.max(since, l.ts);
        }
      };
      // Emit a status event when it changed, and return whether the job is terminal.
      const emitStatus = (job: JobDoc | null): boolean => {
        if (!job) return false;
        if (job.status !== lastStatus) {
          lastStatus = job.status;
          send("status", { status: job.status, url: job.result?.url });
        }
        return TERMINAL.has(job.status);
      };

      // Initial snapshot: existing logs + current status, so a late subscriber sees
      // the backlog immediately (same as the poll loop's first tick did).
      let terminalAlready = false;
      try {
        await drainLogs();
        const job = await getJob(id);
        terminalAlready = emitStatus(job);
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      }
      if (terminalAlready) {
        send("done", { status: lastStatus });
        finish();
        return;
      }

      const startedAt = Date.now();
      const deadline = setTimeout(finish, MAX_MS);
      if (typeof deadline.unref === "function") deadline.unref();

      // ── Change-stream path ──────────────────────────────────────────────────
      // Watch this job's log inserts + this job's status updates in one DB-level
      // change stream. On any relevant event, drain new logs / re-emit status and
      // close on terminal. Falls back to polling on any watch error (standalone
      // Mongo, permissions, or a mid-stream cursor error).
      let cs: ChangeStream | null = null;
      const runFallbackPoll = async () => {
        while (!closed && Date.now() - startedAt < MAX_MS) {
          try {
            // The log read and the status read are independent — run them TOGETHER
            // per tick instead of serially (performance-plan §Area 1 / P1; preserved
            // through the P2 change-stream rework). `since` is captured before the
            // await so the log window is unchanged; logs are still emitted oldest→
            // newest in order after the parallel fetch resolves.
            const [logs, job] = await Promise.all([
              queryLogs({ jobId: id, since }),
              getJob(id),
            ]);
            for (const l of logs) {
              send("log", l);
              since = Math.max(since, l.ts);
            }
            if (emitStatus(job)) {
              send("done", { status: lastStatus });
              finish();
              return;
            }
          } catch (err) {
            send("error", { message: err instanceof Error ? err.message : String(err) });
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        finish();
      };

      try {
        const database = await db();
        // Match ONLY this job's activity: a new log doc for THIS job, OR a write to
        // THIS job's status doc. `updateLookup` populates `fullDocument` on updates,
        // so we can filter on the business `id` in the pipeline — no fleet-wide
        // fan-out of other jobs' writes into this connection.
        cs = database.watch(
          [
            {
              $match: {
                $or: [
                  { "ns.coll": COLLECTIONS.logs, operationType: "insert", "fullDocument.jobId": id },
                  {
                    "ns.coll": COLLECTIONS.jobs,
                    operationType: { $in: ["update", "replace", "insert"] },
                    "fullDocument.id": id,
                  },
                ],
              },
            },
          ],
          { fullDocument: "updateLookup" },
        );

        cs.on("change", (change: ChangeStreamDocument) => {
          void (async () => {
            if (closed) return;
            try {
              const coll = (change as { ns?: { coll?: string } }).ns?.coll;
              if (coll === COLLECTIONS.logs) {
                const full = (change as { fullDocument?: LogDoc }).fullDocument;
                if (full && full.jobId === id) {
                  send("log", full);
                  since = Math.max(since, full.ts);
                }
                return;
              }
              // A jobs-collection write: fullDocument may be any job (we can't cheaply
              // filter on the business `id` in the pipeline since documentKey is _id),
              // so re-read this job's status and emit only when it changed for OUR id.
              const full = (change as { fullDocument?: JobDoc }).fullDocument;
              if (full && full.id !== id) return; // some other job's write — ignore
              const job = full && full.id === id ? full : await getJob(id);
              if (emitStatus(job)) {
                send("done", { status: lastStatus });
                await cs?.close().catch(() => {});
                finish();
              }
            } catch (err) {
              send("error", { message: err instanceof Error ? err.message : String(err) });
            }
          })();
        });

        cs.on("error", () => {
          // Mid-stream cursor failure → close the stream and fall back to polling for
          // the remainder of the window so the client still converges to terminal.
          void cs?.close().catch(() => {});
          cs = null;
          void runFallbackPoll();
        });
        // A race: logs/status could have advanced between the initial snapshot and
        // the watch opening. Drain once more so nothing is missed.
        await drainLogs();
        const job = await getJob(id);
        if (emitStatus(job)) {
          send("done", { status: lastStatus });
          await cs.close().catch(() => {});
          finish();
        }
      } catch {
        // Change streams unavailable (standalone Mongo, or watch() rejected) — use
        // the original 1 s poll. Same SSE contract, just chattier.
        await runFallbackPoll();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
