// lib/logtap.ts — consolidated log tap (Spike SP-1 primitive).
//
// One ordered stream of events merged from every platform the orchestrator
// touches (Vercel build/deploy, Convex CLI, Clerk API) plus the orchestrator
// itself. Clients push `LogEvent`s through a `Logger`; the tap keeps them in
// arrival order and forwards each to an optional sink (stdout in the CLI, Mongo
// `logs` in Workstream B's dashboard). Keeping this a tiny, dependency-free
// primitive is deliberate — it is imported by every client wrapper and by the
// provision engine, and Workstream B promotes it into a streaming service
// (project plan §7.1 SP-1, §7.3 B-3) without changing the event shape.

export type LogSource = "vercel" | "convex" | "clerk" | "orchestrator";
export type LogLevel = "info" | "warn" | "error";

export type LogEvent = {
  source: LogSource;
  level: LogLevel;
  ts: number;
  msg: string;
  jobId?: string;
};

/** Consumer of merged events (stdout printer, Mongo writer, test collector). */
export type LogSink = (e: LogEvent) => void;

/** A source/jobId-bound emitter handed to each client wrapper. */
export type ScopedLogger = (level: LogLevel, msg: string) => LogEvent;

export interface Logger {
  /** Emit a fully-formed event (used when a source builds its own event). */
  emit(e: LogEvent): LogEvent;
  /** Emit a new event, stamping `ts` from the clock. */
  log(source: LogSource, level: LogLevel, msg: string): LogEvent;
  /** A source-bound emitter; carries `jobId` onto every event it produces. */
  for(source: LogSource): ScopedLogger;
  /** The ordered, immutable-to-callers buffer of everything emitted. */
  readonly events: readonly LogEvent[];
  /** Bind a jobId so downstream emitters tag their events (correlation). */
  withJob(jobId: string): Logger;
}

export type MakeLoggerOptions = {
  jobId?: string;
  /** Injectable clock — keeps ordering deterministic in tests. */
  now?: () => number;
};

/**
 * Build a logger. `onLog` is invoked synchronously for every emitted event, in
 * emission order, so a caller can tee to stdout and to persistence at once.
 * Ordering is by arrival (monotonic within a single process), which is what a
 * consolidated tail wants — not per-source wall-clock, which would interleave
 * unpredictably across three APIs with skewed clocks.
 */
export function makeLogger(
  onLog?: LogSink,
  options: MakeLoggerOptions = {},
): Logger {
  const now = options.now ?? Date.now;
  const jobId = options.jobId;
  const events: LogEvent[] = [];

  const logger: Logger = {
    events,
    emit(e: LogEvent): LogEvent {
      // Preserve caller-supplied fields but ensure jobId correlation when the
      // logger is job-scoped and the event didn't set its own.
      const merged: LogEvent =
        jobId && e.jobId === undefined ? { ...e, jobId } : e;
      events.push(merged);
      onLog?.(merged);
      return merged;
    },
    log(source: LogSource, level: LogLevel, msg: string): LogEvent {
      return logger.emit({ source, level, ts: now(), msg });
    },
    for(source: LogSource): ScopedLogger {
      return (level: LogLevel, msg: string) =>
        logger.emit({ source, level, ts: now(), msg, jobId });
    },
    withJob(nextJobId: string): Logger {
      // Child shares the SAME buffer + sink, so a merged tail stays whole.
      const child = makeLogger(onLog, { jobId: nextJobId, now });
      // Re-point the child at the parent buffer so `events` stays consolidated.
      return Object.assign(child, {
        events,
        emit(e: LogEvent): LogEvent {
          const merged: LogEvent =
            e.jobId === undefined ? { ...e, jobId: nextJobId } : e;
          events.push(merged);
          onLog?.(merged);
          return merged;
        },
      });
    },
  };

  return logger;
}

/** Human-readable single line for a merged tail (`refresh-staging`, tests). */
export function formatLogEvent(e: LogEvent): string {
  const iso = new Date(e.ts).toISOString();
  const job = e.jobId ? ` [${e.jobId}]` : "";
  return `${iso} ${e.level.toUpperCase().padEnd(5)} ${e.source.padEnd(12)}${job} ${e.msg}`;
}

/** A sink that prints merged events to stdout/stderr (CLI default). */
export function consoleSink(e: LogEvent): void {
  const line = formatLogEvent(e);
  if (e.level === "error") console.error(line);
  else console.log(line);
}
