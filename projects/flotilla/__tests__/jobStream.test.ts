import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// PERF-P2: the job-log SSE stream is driven by a Mongo change stream, falling back
// to the 1s poll when change streams are unavailable. These tests exercise the
// FALLBACK path (db.watch() throws) deterministically and assert the SSE contract
// is byte-for-byte the same: backlog `log` events, a `status` event, and a `done`
// close on terminal status.

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

const { getJob, queryLogs } = vi.hoisted(() => ({ getJob: vi.fn(), queryLogs: vi.fn() }));
vi.mock("@/lib/models", () => ({ getJob, queryLogs }));

// db().watch() throws → the route falls back to polling. COLLECTIONS is read at
// module top for the (unused-in-fallback) pipeline; provide the real names.
vi.mock("@/lib/mongo", () => ({
  db: async () => ({
    watch: () => {
      throw new Error("change streams require a replica set");
    },
  }),
  COLLECTIONS: { jobs: "flotilla_jobs", logs: "flotilla_logs" },
}));

import { GET } from "@/app/api/jobs/[id]/stream/route";

// Read the whole SSE body into a string (the stream self-closes on terminal).
async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

function call(id: string) {
  return GET(new Request(`http://localhost/api/jobs/${id}/stream`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  principal = { kind: "clerk", id: "op@example.com", role: "write" as Role };
  getJob.mockReset();
  queryLogs.mockReset();
});

describe("GET /jobs/:id/stream — change-stream with poll fallback (PERF-P2)", () => {
  it("401s an unauthenticated caller before opening the stream", async () => {
    principal = null;
    const res = await call("j1");
    expect(res.status).toBe(401);
  });

  it("streams backlog logs + terminal status, then closes (fallback path)", async () => {
    // Terminal on the very first snapshot: emits logs + status + done immediately,
    // no polling needed — proves the initial-snapshot fast close.
    queryLogs.mockResolvedValue([
      { ts: 1, seq: 1, source: "orchestrator", level: "info", msg: "start", jobId: "j1" },
      { ts: 2, seq: 2, source: "orchestrator", level: "info", msg: "done", jobId: "j1" },
    ]);
    getJob.mockResolvedValue({ id: "j1", status: "succeeded", result: { url: "https://x" } });

    const res = await call("j1");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await readSse(res);

    // Contract: two log events, a status event carrying the url, and a done event.
    expect(body).toContain('event: log\ndata: {"ts":1');
    expect(body).toContain('event: log\ndata: {"ts":2');
    expect(body).toContain('event: status\ndata: {"status":"succeeded","url":"https://x"}');
    expect(body).toContain('event: done\ndata: {"status":"succeeded"}');
  });

  it("polls until the job reaches a terminal state, then closes (fallback path)", async () => {
    // First tick running, second tick succeeded — the fallback loop must poll twice.
    queryLogs.mockResolvedValue([]);
    getJob
      .mockResolvedValueOnce({ id: "j1", status: "running" }) // initial snapshot
      .mockResolvedValueOnce({ id: "j1", status: "running" }) // post-watch drain
      .mockResolvedValue({ id: "j1", status: "succeeded" }); // fallback poll → terminal

    const body = await readSse(await call("j1"));
    expect(body).toContain('event: status\ndata: {"status":"running"}');
    expect(body).toContain('event: done\ndata: {"status":"succeeded"}');
    // Status is emitted only on change — "running" appears once, not per tick.
    expect(body.match(/event: status\ndata: {"status":"running"}/g)?.length).toBe(1);
  });
});

// A fake change stream (EventEmitter-ish) whose watch() the route drives. We push
// a log-insert change then a terminal jobs change and assert the route emits + closes.
describe("GET /jobs/:id/stream — change-stream path (PERF-P2)", () => {
  it("emits a log on a log-insert change and closes on a terminal jobs change", async () => {
    type Handler = (arg: unknown) => void;
    const handlers: Record<string, Handler[]> = {};
    let closed = false;
    const cs = {
      on(ev: string, h: Handler) {
        (handlers[ev] ??= []).push(h);
      },
      async close() {
        closed = true;
      },
      emit(ev: string, arg: unknown) {
        for (const h of handlers[ev] ?? []) h(arg);
      },
    };
    // Re-mock db() to hand back this fake change stream instead of throwing.
    const mongo = await import("@/lib/mongo");
    vi.spyOn(mongo, "db").mockResolvedValue({ watch: () => cs } as never);

    principal = { kind: "clerk", id: "op@example.com", role: "write" as Role };
    queryLogs.mockResolvedValue([]); // no backlog
    getJob.mockResolvedValue({ id: "j1", status: "running" });

    const res = await call("j1");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    // Give the start() body a tick to open the watch + drain, then drive changes.
    await new Promise((r) => setTimeout(r, 20));
    // A new log line arrives via the change stream.
    cs.emit("change", {
      ns: { coll: "flotilla_logs" },
      operationType: "insert",
      fullDocument: { ts: 5, seq: 9, source: "orchestrator", level: "info", msg: "streamed", jobId: "j1" },
    });
    // The job goes terminal via the change stream.
    getJob.mockResolvedValue({ id: "j1", status: "succeeded", result: { url: "https://y" } });
    cs.emit("change", {
      ns: { coll: "flotilla_jobs" },
      operationType: "update",
      fullDocument: { id: "j1", status: "succeeded", result: { url: "https://y" } },
    });

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    expect(out).toContain('event: log\ndata: {"ts":5');
    expect(out).toContain('event: status\ndata: {"status":"succeeded","url":"https://y"}');
    expect(out).toContain('event: done\ndata: {"status":"succeeded"}');
    expect(closed).toBe(true);
  });
});
